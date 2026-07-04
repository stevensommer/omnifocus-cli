import { outputJson } from './output.js';

export class OmniFocusCliError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500
  ) {
    super(message);
    this.name = 'OmniFocusCliError';
  }
}

export interface ErrorInfo {
  name: string;
  detail: string;
  statusCode: number;
}

/**
 * Map an arbitrary thrown value to the CLI's structured error shape. Shared
 * by the CLI's handleError and the MCP server's isError tool results so both
 * surfaces report identical error JSON.
 */
export function classifyError(error: unknown): ErrorInfo {
  if (error instanceof OmniFocusCliError) {
    return { name: 'cli_error', detail: error.message, statusCode: error.statusCode };
  }
  if (error instanceof Error) {
    let statusCode = 500;
    if (error.message.includes('not found')) {
      statusCode = 404;
    } else if (error.message.includes('Multiple')) {
      statusCode = 400;
    }
    return { name: 'omnifocus_error', detail: error.message, statusCode };
  }
  return { name: 'unknown_error', detail: 'An unknown error occurred', statusCode: 500 };
}

export function handleError(error: unknown): void {
  outputJson({ error: classifyError(error) });
  // Set exitCode instead of calling process.exit() to let the stdout pipe
  // buffer drain before the process terminates. Calling process.exit()
  // truncates piped output at ~512 bytes on macOS because pipe writes are
  // asynchronous. See https://nodejs.org/api/process.html#processexitcode
  process.exitCode = 1;
}
