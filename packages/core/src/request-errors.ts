/**
 * Typed request/validation errors the control-plane wire maps to structured
 * error codes (see the `@openqueue/workbench` control routes). They extend the
 * built-in `Error` and pull in nothing, so `@openqueue/core/world` re-exports
 * them into the edge control bundle alongside {@link UnsupportedCapabilityError}
 * without dragging the runtime graph along.
 */

/** A task id that has no published catalog entry. Maps to `task_not_found`. */
export class UnknownTaskError extends Error {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`Unknown task "${taskId}"; worker catalog has not been published`);
    this.name = 'UnknownTaskError';
    this.taskId = taskId;
  }
}

/** A malformed cron/timezone on a schedule request. Maps to `invalid_request`. */
export class InvalidScheduleError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InvalidScheduleError';
  }
}
