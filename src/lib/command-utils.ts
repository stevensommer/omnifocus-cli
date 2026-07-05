import { handleError, OmniFocusCliError } from './errors.js';

export function withErrorHandling<T extends unknown[], R>(
  fn: (...args: T) => Promise<R>
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await fn(...args);
    } catch (error) {
      handleError(error);
    }
  };
}

/**
 * Reject any --status value outside an allowed set, called from inside an
 * action handler (so withErrorHandling turns a bad value into a clean JSON
 * 400 instead of an uncaught throw). Without this, free-text CLI options
 * reach omnifocus.ts and get interpolated into generated Omni Automation
 * source — restricting to a known-safe enum here is defence in depth
 * alongside escaping in omnifocus.ts, and gives a much clearer error than a
 * downstream Omni Automation script failure.
 *
 * Deliberately not wired up as a Commander option-parser: a parser that
 * throws runs before the action (and before withErrorHandling's try/catch),
 * and Commander's exitOverride() swallows the message, producing a silent
 * `exit 1` with no JSON error at all.
 */
export function validateStatus<T extends string>(
  value: string | undefined,
  allowed: readonly T[]
): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new OmniFocusCliError(`Invalid status "${value}". Valid: ${allowed.join(', ')}`, 400);
  }
  return value as T;
}
