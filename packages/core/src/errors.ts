import type { SerializedError } from './types';

export class RetryableError extends Error {
  readonly retryable = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RetryableError';
  }
}

export class NonRetryableError extends Error {
  readonly retryable = false;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NonRetryableError';
  }
}

export class JobTimeoutError extends NonRetryableError {
  constructor(message = 'Job exceeded TTL') {
    super(message);
    this.name = 'JobTimeoutError';
  }
}

export class JobExpiredError extends NonRetryableError {
  constructor(message = 'Job expired before execution') {
    super(message);
    this.name = 'JobExpiredError';
  }
}

export class JobCanceledError extends NonRetryableError {
  constructor(message = 'Job was canceled') {
    super(message);
    this.name = 'JobCanceledError';
  }
}

export function isNonRetryable(err: unknown): boolean {
  if (err instanceof NonRetryableError) return true;
  if (
    err &&
    typeof err === 'object' &&
    'retryable' in err &&
    (err as { retryable?: unknown }).retryable === false
  )
    return true;
  return false;
}

export function serializeError(
  err: unknown,
  override?: { retryable?: boolean },
): SerializedError {
  if (err instanceof Error) {
    const retryable =
      override?.retryable ??
      (err as unknown as { retryable?: boolean }).retryable;
    const cause =
      'cause' in err && err.cause ? serializeError(err.cause) : undefined;
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      code:
        'code' in err && typeof err.code === 'string' ? err.code : undefined,
      ...(retryable !== undefined ? { retryable } : {}),
      ...(cause ? { cause } : {}),
    };
  }
  return {
    name: 'UnknownError',
    message: typeof err === 'string' ? err : JSON.stringify(err),
    ...(override?.retryable !== undefined
      ? { retryable: override.retryable }
      : {}),
  };
}
