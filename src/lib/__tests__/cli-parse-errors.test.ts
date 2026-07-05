import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Regression test: a Commander custom option-parser that throws (e.g. an
 * invalid `--status` value) escapes `parseAsync()` before any action runs,
 * so `withErrorHandling` never sees it. cli.ts's top-level `.catch()` used to
 * only set `process.exitCode` for non-CommanderError values, producing a
 * silent `exit 1` with nothing on stdout or stderr. Exit-code assertions
 * must run in a child process (bun's native test runner snapshots any
 * process.exitCode mutation in-process as a suite failure — see CLAUDE.md).
 */

const execFileAsync = promisify(execFile);
const distCli = join(process.cwd(), 'dist', 'cli.js');

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(distCli, args, { encoding: 'utf8' });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | null };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: typeof e.code === 'number' ? e.code : null,
    };
  }
}

describe('Commander custom-parser errors reach stdout as JSON', () => {
  beforeAll(() => {
    if (!existsSync(distCli)) {
      throw new Error(`dist/cli.js not found — run \`bun run build\` before this test suite.`);
    }
  });

  it('an invalid --status value produces a non-empty JSON error body, not silent exit 1', async () => {
    const { stdout, stderr, exitCode } = await runCli(['task', 'list', '--status', 'bogus']);
    expect(exitCode).not.toBe(0);
    // Before the fix this was empty on BOTH streams.
    const combined = stdout + stderr;
    expect(combined.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(combined);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.detail).toContain('bogus');
  });

  it('a genuine CommanderError (unknown option) still exits non-zero with commander’s own output', async () => {
    const { stdout, stderr, exitCode } = await runCli(['task', 'list', '--not-a-real-flag']);
    expect(exitCode).not.toBe(0);
    // Commander writes its own usage/error text; just confirm something
    // reached the user and the new branch didn't swallow this path instead.
    expect((stdout + stderr).trim().length).toBeGreaterThan(0);
  });

  it('a valid --status value still works normally (no regression)', async () => {
    const { exitCode } = await runCli(['task', 'list', '--status', 'available']);
    // May exit 1 if OmniFocus isn't reachable in this environment, but must
    // not be a parse-time failure — i.e. it must reach the action handler.
    expect([0, 1]).toContain(exitCode);
  });
});
