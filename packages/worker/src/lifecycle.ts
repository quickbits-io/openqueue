/**
 * How long a lifecycle hook is awaited before the worker stops waiting on it.
 * Generous for the enqueue the hooks are meant for, and short enough to leave
 * most of a typical 30s termination grace period to the consumer drain.
 */
export const HOOK_TIMEOUT_MS = 10_000;

/**
 * Await a lifecycle hook without letting it own the process: a throwing hook is
 * logged, and a hook still running after {@link HOOK_TIMEOUT_MS} is abandoned —
 * not cancelled — so it can neither hold the port shut on boot nor eat the
 * shutdown grace period. An abandoned hook keeps running, and a late rejection
 * is logged rather than surfacing as an unhandled rejection.
 */
export async function runHook(
  name: 'onReady' | 'onShutdown',
  run: () => unknown,
): Promise<void> {
  const settled = (async () => {
    try {
      await run();
    } catch (err) {
      console.error(`[openqueue] ${name} hook failed`, err);
    }
    return false;
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), HOOK_TIMEOUT_MS);
  });

  const timedOut = await Promise.race([settled, expired]);
  clearTimeout(timer);
  if (timedOut) {
    console.error(
      `[openqueue] ${name} hook still running after ${HOOK_TIMEOUT_MS}ms — continuing without it`,
    );
  }
}
