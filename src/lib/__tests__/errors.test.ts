import { describe, it, expect, beforeAll } from 'vitest';
import { classifyError, OmniFocusCliError } from '../errors.js';
import { parseStatusFilter } from '../../commands/task.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * These tests run handleError in a child process. The function deliberately
 * sets process.exitCode = 1 to fix issue #20 (stdout truncation when piped),
 * so we can't call it inside the test runner — bun's native test runner
 * treats any process.exitCode mutation as a suite failure, even when reverted.
 *
 * Spawning a child process also gives us a faithful end-to-end test: we can
 * pipe the child's stdout and confirm that the JSON error body arrives
 * intact (not truncated) and that the exit code is correctly propagated.
 */

const execFileAsync = promisify(execFile);

interface HandleErrorResult {
  stdout: string;
  exitCode: number | null;
}

async function runHandleError(
  scenario:
    | 'omnifocus_cli_error'
    | 'error_not_found'
    | 'error_multiple'
    | 'error_plain'
    | 'non_error'
): Promise<HandleErrorResult> {
  const tmp = await mkdtemp(join(tmpdir(), 'of-errors-test-'));
  const script = join(tmp, 'run.mjs');
  try {
    await writeFile(
      script,
      `
import { handleError, OmniFocusCliError } from '${join(process.cwd(), 'src/lib/errors.ts')}';

let error;
switch (${JSON.stringify(scenario)}) {
  case 'omnifocus_cli_error':
    error = new OmniFocusCliError('bad request', 400);
    break;
  case 'error_not_found':
    error = new Error('Task not found: abc');
    break;
  case 'error_multiple':
    error = new Error("Multiple tags found with name 'foo'");
    break;
  case 'error_plain':
    error = new Error('boom');
    break;
  case 'non_error':
    error = 'something weird';
    break;
}

handleError(error);
// Intentionally do NOT call process.exit(). The whole point of handleError
// is that it sets exitCode and lets the loop drain. If anything is broken
// the test will hang or truncate.
`,
      'utf8'
    );

    try {
      const { stdout } = await execFileAsync('bun', [script], { encoding: 'utf8' });
      return { stdout, exitCode: 0 };
    } catch (err) {
      const e = err as { stdout?: string; code?: number | null };
      return { stdout: e.stdout ?? '', exitCode: typeof e.code === 'number' ? e.code : null };
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// classifyError is pure (no exitCode mutation), so unlike handleError it can
// be exercised directly in-process.
describe('classifyError', () => {
  it('preserves OmniFocusCliError statusCode', () => {
    expect(classifyError(new OmniFocusCliError('bad request', 400))).toEqual({
      name: 'cli_error',
      detail: 'bad request',
      statusCode: 400,
    });
  });

  it('maps the find* sentinel shapes to 404 / 400', () => {
    // Real messages from the JXA find* helpers: "<Type> not found: <id>" and
    // "Multiple <type> found with name ...".
    expect(classifyError(new Error('Task not found: kXu3B-LZfFH')).statusCode).toBe(404);
    expect(
      classifyError(new Error("Multiple tags found with name 'foo'. Please use full path"))
        .statusCode
    ).toBe(400);
  });

  it('does NOT miscode unrelated errors that merely contain the words', () => {
    // The reviewer's false-positive cases: loose substrings must not trigger.
    expect(classifyError(new Error('Application not found')).statusCode).toBe(500);
    expect(classifyError(new Error('Multiple windows open')).statusCode).toBe(500);
  });

  it('defaults plain errors to 500 and non-errors to unknown_error', () => {
    expect(classifyError(new Error('boom'))).toEqual({
      name: 'omnifocus_error',
      detail: 'boom',
      statusCode: 500,
    });
    expect(classifyError('weird')).toEqual({
      name: 'unknown_error',
      detail: 'An unknown error occurred',
      statusCode: 500,
    });
  });
});

describe('parseStatusFilter error consistency', () => {
  it('rejects an invalid status with a 400 OmniFocusCliError (like isoDateArg)', () => {
    let thrown: unknown;
    try {
      parseStatusFilter('bogus');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OmniFocusCliError);
    expect((thrown as OmniFocusCliError).statusCode).toBe(400);
    // And it classifies as a client error, not a generic 500.
    expect(classifyError(thrown)).toEqual({
      name: 'cli_error',
      detail: expect.stringContaining('Invalid status "bogus"'),
      statusCode: 400,
    });
  });

  it('returns valid statuses unchanged', () => {
    expect(parseStatusFilter('completed')).toBe('completed');
  });
});

describe('handleError', () => {
  beforeAll(() => {
    // Sanity check the helper compiles cleanly; nothing else needed.
  });

  it('exits with code 1 instead of calling process.exit', async () => {
    const { exitCode } = await runHandleError('error_plain');
    expect(exitCode).toBe(1);
  });

  it('writes a complete JSON error body when piped (no truncation)', async () => {
    const { stdout } = await runHandleError('error_plain');
    // The full JSON must parse — proves stdout drained before exit.
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({
      error: { name: 'omnifocus_error', detail: 'boom', statusCode: 500 },
    });
  });

  it('serializes OmniFocusCliError with its statusCode', async () => {
    const { stdout } = await runHandleError('omnifocus_cli_error');
    expect(JSON.parse(stdout)).toEqual({
      error: { name: 'cli_error', detail: 'bad request', statusCode: 400 },
    });
  });

  it('maps "not found" errors to 404', async () => {
    const { stdout } = await runHandleError('error_not_found');
    expect(JSON.parse(stdout)).toEqual({
      error: { name: 'omnifocus_error', detail: 'Task not found: abc', statusCode: 404 },
    });
  });

  it('maps "Multiple" errors to 400', async () => {
    const { stdout } = await runHandleError('error_multiple');
    expect(JSON.parse(stdout)).toEqual({
      error: {
        name: 'omnifocus_error',
        detail: "Multiple tags found with name 'foo'",
        statusCode: 400,
      },
    });
  });

  it('falls back to unknown_error for non-Error values', async () => {
    const { stdout } = await runHandleError('non_error');
    expect(JSON.parse(stdout)).toEqual({
      error: { name: 'unknown_error', detail: 'An unknown error occurred', statusCode: 500 },
    });
  });
});
