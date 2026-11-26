/**
 * Centralized error handling primitives.
 *
 * Every layer that can fail (storage, messaging, future scraping/parsing
 * logic) should surface failures through `AppError` and `Result` rather
 * than throwing ad hoc errors or silently swallowing them. This keeps
 * error handling consistent between the background worker, content
 * scripts, and UI, and makes failures easy to log, display, and test.
 */

/** Stable machine-readable error categories used across the extension. */
export type ErrorCode =
  | 'STORAGE_READ_FAILED'
  | 'STORAGE_WRITE_FAILED'
  | 'MESSAGING_FAILED'
  | 'MESSAGING_TIMEOUT'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'EXTENSION_CONTEXT_INVALIDATED'
  | 'UNKNOWN';

/**
 * Chrome's own error strings for a stale extension context - thrown by
 * `chrome.runtime`/`chrome.storage` calls from a content script whose
 * extension was reloaded, updated, or uninstalled while the page stayed
 * open. These are raw and unhelpful shown verbatim ("Extension context
 * invalidated."), and nothing else in this content script can recover
 * on its own once this happens - every future call fails the same way
 * until the page itself is reloaded. Matched by substring since Chrome
 * doesn't expose a stable error code for these, only these messages.
 */
const CONTEXT_INVALIDATED_PATTERNS = [
  'extension context invalidated',
  'could not establish connection',
  'receiving end does not exist',
  'message port closed before a response',
];

/** True when `error` is one of Chrome's stale-extension-context failures (see `CONTEXT_INVALIDATED_PATTERNS`). */
export function isExtensionContextInvalidated(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
          ? (error as { message: string }).message
          : '';
  const lower = message.toLowerCase();
  return CONTEXT_INVALIDATED_PATTERNS.some((pattern) => lower.includes(pattern));
}

export interface AppErrorOptions {
  code: ErrorCode;
  message: string;
  cause?: unknown;
  context?: Record<string, unknown>;
}

/**
 * A typed application error. Prefer constructing this (directly or via
 * `AppError.from`) over throwing raw `Error`s so callers can branch on
 * `code` instead of parsing message strings.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly context?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor({ code, message, cause, context }: AppErrorOptions) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.cause = cause;
    this.context = context;
  }

  /** Normalizes any thrown value into an `AppError`. */
  static from(error: unknown, fallbackCode: ErrorCode = 'UNKNOWN'): AppError {
    if (error instanceof AppError) return error;
    if (isExtensionContextInvalidated(error)) {
      return new AppError({
        code: 'EXTENSION_CONTEXT_INVALIDATED',
        message: 'Monitor was updated and lost its connection to this page. Reload the page to reconnect.',
        cause: error,
      });
    }
    if (error instanceof Error) {
      return new AppError({
        code: fallbackCode,
        message: error.message,
        cause: error,
      });
    }
    return new AppError({
      code: fallbackCode,
      message: typeof error === 'string' ? error : 'An unknown error occurred.',
      cause: error,
    });
  }

  /** True when reconnecting requires reloading the page - no retry, message, or storage call in this content script can recover from this. */
  get requiresReload(): boolean {
    return this.code === 'EXTENSION_CONTEXT_INVALIDATED';
  }

  /** User-safe message. Falls back to a generic string for unknown errors. */
  toDisplayMessage(): string {
    return this.message || 'Something went wrong. Please try again.';
  }
}

export type Result<T, E = AppError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E = AppError>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Runs an async operation and converts thrown errors into a `Result`
 * instead of letting them propagate. Use this at I/O boundaries
 * (storage, messaging, network) so callers handle failure explicitly.
 */
export async function tryCatch<T>(
  operation: () => Promise<T>,
  fallbackCode: ErrorCode = 'UNKNOWN',
): Promise<Result<T>> {
  try {
    const value = await operation();
    return ok(value);
  } catch (error) {
    return err(AppError.from(error, fallbackCode));
  }
}

/** Synchronous variant of `tryCatch`. */
export function tryCatchSync<T>(
  operation: () => T,
  fallbackCode: ErrorCode = 'UNKNOWN',
): Result<T> {
  try {
    return ok(operation());
  } catch (error) {
    return err(AppError.from(error, fallbackCode));
  }
}
