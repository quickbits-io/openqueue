/**
 * Shared internal helpers for `@openqueue/workbench`. Keep these generic and
 * dependency-free — domain-specific guards belong next to their types.
 */

/** Narrow an unknown value to an indexable object (excludes `null`). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Parse JSON, returning `undefined` instead of throwing on invalid input. */
export function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
