export type ClientErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid_request'
  | 'server_error'
  | 'network_error'
  | 'invalid_response';

export class OpenQueueClientError extends Error {
  readonly code: ClientErrorCode;
  readonly status?: number;
  /** Raw wire error body when the server sent one. */
  readonly details?: unknown;

  constructor(
    code: ClientErrorCode,
    message: string,
    opts?: { status?: number; details?: unknown; cause?: unknown },
  ) {
    super(
      message,
      opts?.cause === undefined ? undefined : { cause: opts.cause },
    );
    this.name = 'OpenQueueClientError';
    this.code = code;
    this.status = opts?.status;
    this.details = opts?.details;
  }
}
