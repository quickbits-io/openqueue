import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalTransport } from '../local';
import type {
  ConsumeOptions,
  QueueTransport,
  TransportConsumer,
  TransportJobSpec,
} from '../types';

/**
 * Behaviour beyond the shared conformance suite: the flow-failure flag matrix
 * (blocked-parent default, ignore/continue/failParent), grandparent recursion
 * gated on the middle parent's own flag with no parent worker callback,
 * child-remove unblocking a parent, exponential backoff timing, and close()
 * clearing pending delayed timers.
 */
describe('local transport', () => {
  const transports: QueueTransport[] = [];
  const consumers: TransportConsumer[] = [];

  afterEach(async () => {
    await Promise.all(consumers.splice(0).map((c) => c.close()));
    await Promise.all(transports.splice(0).map((t) => t.close()));
  });

  function make(): QueueTransport {
    const transport = createLocalTransport();
    transports.push(transport);
    return transport;
  }

  function consume(
    transport: QueueTransport,
    queue: string,
    options: Partial<ConsumeOptions>,
  ): TransportConsumer {
    const consumer = transport.consume(queue, {
      isFinal: (err) => err instanceof Error && err.message === 'final',
      process: async () => undefined,
      onCompleted: () => undefined,
      onFailed: () => undefined,
      onError: () => undefined,
      ...options,
    });
    consumers.push(consumer);
    return consumer;
  }

  it('leaves a parent blocked when a child fails with no flag (default)', async () => {
    const transport = make();
    const order: string[] = [];
    consume(transport, 'p', {
      process: async () => {
        order.push('parent');
      },
    });
    const childFailed = deferred<void>();
    consume(transport, 'c', {
      process: async () => {
        throw new Error('final');
      },
      onFailed: () => childFailed.resolve(),
    });

    await transport.enqueueFlow({
      queue: 'p',
      spec: spec({ id: 'parent', name: 'parent' }),
      children: [{ queue: 'c', spec: spec({ id: 'child', name: 'child' }) }],
    });

    await childFailed.promise;
    await sleep(150);
    expect(order).toEqual([]);
    // The parent is still parked in the map, waiting on a child that never
    // completes.
    expect(await transport.getJob('p', 'parent')).toBeDefined();
  });

  it('promotes the parent when a failed child sets ignoreDependencyOnFailure', async () => {
    const transport = make();
    const order: string[] = [];
    consume(transport, 'p', {
      process: async () => {
        order.push('parent');
      },
    });
    consume(transport, 'c', {
      process: async () => {
        throw new Error('final');
      },
    });

    await transport.enqueueFlow({
      queue: 'p',
      spec: spec({ id: 'parent', name: 'parent' }),
      children: [
        {
          queue: 'c',
          spec: spec({
            id: 'child',
            name: 'child',
            ignoreDependencyOnFailure: true,
          }),
        },
      ],
    });

    await waitFor(() => order.length === 1);
    expect(order).toEqual(['parent']);
  });

  it('promotes the parent immediately when a failed child sets continueParentOnFailure', async () => {
    const transport = make();
    const order: string[] = [];
    consume(transport, 'p', {
      process: async () => {
        order.push('parent');
      },
    });
    consume(transport, 'c', {
      process: async () => {
        throw new Error('final');
      },
    });

    await transport.enqueueFlow({
      queue: 'p',
      spec: spec({ id: 'parent', name: 'parent' }),
      children: [
        {
          queue: 'c',
          spec: spec({
            id: 'child',
            name: 'child',
            continueParentOnFailure: true,
          }),
        },
      ],
    });

    await waitFor(() => order.length === 1);
    expect(order).toEqual(['parent']);
  });

  it('fails a grandparent only when the middle parent opts in, with no parent callback', async () => {
    const transport = make();
    const parentFailures: unknown[] = [];
    const grandFailures: unknown[] = [];
    consume(transport, 'gp', {
      onFailed: (job) => {
        grandFailures.push(job);
      },
    });
    consume(transport, 'p', {
      onFailed: (job) => {
        parentFailures.push(job);
      },
    });
    const childFailed = deferred<void>();
    consume(transport, 'c', {
      process: async () => {
        throw new Error('final');
      },
      onFailed: () => childFailed.resolve(),
    });

    // child (failParentOnFailure) → fails parent; parent (failParentOnFailure)
    // → fails grandparent.
    await transport.enqueueFlow({
      queue: 'gp',
      spec: spec({ id: 'gp', name: 'gp' }),
      children: [
        {
          queue: 'p',
          spec: spec({ id: 'p', name: 'p', failParentOnFailure: true }),
          children: [
            {
              queue: 'c',
              spec: spec({
                id: 'c',
                name: 'c',
                failParentOnFailure: true,
              }),
            },
          ],
        },
      ],
    });

    await childFailed.promise;
    await sleep(100);
    expect(await transport.getJob('p', 'p')).toBeUndefined();
    expect(await transport.getJob('gp', 'gp')).toBeUndefined();
    // The parent and grandparent are failed by the flow, never delivered, so no
    // worker onFailed fires for them.
    expect(parentFailures).toEqual([]);
    expect(grandFailures).toEqual([]);
  });

  it('does not recurse to the grandparent when the middle parent lacks the flag', async () => {
    const transport = make();
    const childFailed = deferred<void>();
    consume(transport, 'c', {
      process: async () => {
        throw new Error('final');
      },
      onFailed: () => childFailed.resolve(),
    });

    await transport.enqueueFlow({
      queue: 'gp',
      spec: spec({ id: 'gp', name: 'gp' }),
      children: [
        {
          // No failParentOnFailure on the middle parent.
          queue: 'p',
          spec: spec({ id: 'p', name: 'p' }),
          children: [
            {
              queue: 'c',
              spec: spec({
                id: 'c',
                name: 'c',
                failParentOnFailure: true,
              }),
            },
          ],
        },
      ],
    });

    await childFailed.promise;
    await sleep(100);
    expect(await transport.getJob('p', 'p')).toBeUndefined();
    // Grandparent stays blocked because the middle parent never opted it in.
    expect(await transport.getJob('gp', 'gp')).toBeDefined();
  });

  it('unblocks a parent when its pending child is removed', async () => {
    const transport = make();
    const order: string[] = [];
    consume(transport, 'p', {
      process: async () => {
        order.push('parent');
      },
    });
    // No consumer on the child queue, so the child stays waiting.

    await transport.enqueueFlow({
      queue: 'p',
      spec: spec({ id: 'parent', name: 'parent' }),
      children: [{ queue: 'c', spec: spec({ id: 'child', name: 'child' }) }],
    });

    const child = await transport.getJob('c', 'child');
    expect(child).toBeDefined();
    await child?.remove();

    await waitFor(() => order.length === 1);
    expect(order).toEqual(['parent']);
  });

  it('refreshes processedOn on each retry so a retry reports its own start, not attempt 1', async () => {
    const transport = make();
    const processedOns: number[] = [];
    const completed = deferred<void>();
    consume(transport, 'q', {
      process: async (job) => {
        processedOns.push(job.processedOn ?? Number.NaN);
        if (job.attemptsMade === 0) throw new Error('retry');
      },
      onCompleted: () => completed.resolve(),
    });

    await transport.enqueue(
      'q',
      spec({
        id: 'r',
        name: 'x',
        attempts: 2,
        backoff: { type: 'fixed', delay: 200 },
      }),
    );

    await completed.promise;
    expect(processedOns).toHaveLength(2);
    expect(Number.isFinite(processedOns[0] ?? Number.NaN)).toBe(true);
    expect(Number.isFinite(processedOns[1] ?? Number.NaN)).toBe(true);
    // Attempt 2's processedOn advanced by ~the backoff — stamped per attempt,
    // not preserved from attempt 1 (which would make the gap ~0).
    expect(
      (processedOns[1] ?? 0) - (processedOns[0] ?? 0),
    ).toBeGreaterThanOrEqual(150);
  });

  it('spaces retries with exponential backoff', async () => {
    const transport = make();
    const gaps: number[] = [];
    let last = 0;
    consume(transport, 'q', {
      process: async () => {
        const now = Date.now();
        if (last !== 0) gaps.push(now - last);
        last = now;
        throw new Error('retry');
      },
    });

    await transport.enqueue(
      'q',
      spec({
        id: 'e',
        name: 'x',
        attempts: 4,
        backoff: { type: 'exponential', delay: 50 },
      }),
    );

    await waitFor(() => gaps.length === 3, 3000);
    // Gaps target 50, 100, 200ms — assert monotonic growth with loose bounds
    // to absorb timer jitter.
    const [g1, g2, g3] = gaps;
    expect(g1 ?? 0).toBeGreaterThanOrEqual(30);
    expect(g2 ?? 0).toBeGreaterThan(g1 ?? 0);
    expect(g3 ?? 0).toBeGreaterThan(g2 ?? 0);
    expect(g3 ?? 0).toBeGreaterThanOrEqual(120);
  });

  it('clears pending delayed timers on close()', async () => {
    const transport = createLocalTransport();
    const processed: string[] = [];
    transport.consume('q', {
      isFinal: () => false,
      process: async (job) => {
        processed.push(job.id ?? '');
      },
      onCompleted: () => undefined,
      onFailed: () => undefined,
      onError: () => undefined,
    });

    await transport.enqueue('q', spec({ id: 'late', name: 'x', delay: 5000 }));
    expect((await transport.listDelayed('q')).length).toBe(1);

    await transport.close();
    await sleep(200);
    expect(processed).toEqual([]);
  });

  it('dispatches a job re-enqueued to the same queue from inside process()', async () => {
    const transport = make();
    const processed: string[] = [];
    let followedUp = false;
    consume(transport, 'q', {
      concurrency: 1,
      process: async (job) => {
        processed.push(job.id ?? '');
        if (job.id === 'a' && !followedUp) {
          followedUp = true;
          await transport.enqueue('q', spec({ id: 'b', name: 'x' }));
        }
      },
    });

    await transport.enqueue('q', spec({ id: 'a', name: 'x' }));
    await waitFor(() => processed.length === 2);
    await sleep(100);
    // The re-entrant enqueue neither double-dispatches 'a' nor loses 'b'.
    expect(processed).toEqual(['a', 'b']);
  });

  it('never exceeds concurrency while jobs fail and retry', async () => {
    const transport = make();
    let inFlight = 0;
    let peak = 0;
    const settled = new Set<string>();
    const attempts = new Map<string, number>();
    consume(transport, 'q', {
      concurrency: 2,
      process: async (job) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep(20);
        const id = job.id ?? '';
        const n = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, n);
        inFlight -= 1;
        if ((id === 'j1' || id === 'j3') && n === 1) throw new Error('retry');
      },
      onCompleted: (job) => {
        if (job.id) settled.add(job.id);
      },
      onFailed: (job, _err, { final }) => {
        if (final && job?.id) settled.add(job.id);
      },
    });

    for (let i = 0; i < 5; i++) {
      await transport.enqueue(
        'q',
        spec({
          id: `j${i}`,
          name: 'x',
          attempts: 3,
          backoff: { type: 'fixed', delay: 10 },
        }),
      );
    }

    await waitFor(() => settled.size === 5, 5000);
    expect(peak).toBeLessThanOrEqual(2);
    expect([...settled].sort()).toEqual(['j0', 'j1', 'j2', 'j3', 'j4']);
  });

  it('settles a continueParentOnFailure parent once with a sibling still in-flight', async () => {
    const transport = make();
    const parentRuns: number[] = [];
    const siblingRelease = deferred<void>();
    let siblingDone = false;
    consume(transport, 'p', {
      process: async () => {
        parentRuns.push(Date.now());
      },
    });
    consume(transport, 'a', {
      process: async () => {
        throw new Error('final');
      },
    });
    consume(transport, 'b', {
      process: async () => {
        await siblingRelease.promise;
        siblingDone = true;
      },
    });

    await transport.enqueueFlow({
      queue: 'p',
      spec: spec({ id: 'parent', name: 'parent' }),
      children: [
        {
          queue: 'a',
          spec: spec({ id: 'a', name: 'a', continueParentOnFailure: true }),
        },
        { queue: 'b', spec: spec({ id: 'b', name: 'b' }) },
      ],
    });

    // Child 'a' fails and promotes the parent while sibling 'b' is still busy.
    await waitFor(() => parentRuns.length === 1);
    siblingRelease.resolve();
    await waitFor(() => siblingDone);
    await sleep(150);
    // The late sibling settlement is a no-op — the parent is not re-promoted.
    expect(parentRuns.length).toBe(1);
  });

  it('leaves the grandparent blocked when the middle parent has the flag but its child does not', async () => {
    const transport = make();
    const childFailed = deferred<void>();
    consume(transport, 'c', {
      process: async () => {
        throw new Error('final');
      },
      onFailed: () => childFailed.resolve(),
    });

    await transport.enqueueFlow({
      queue: 'gp',
      spec: spec({ id: 'gp', name: 'gp' }),
      children: [
        {
          // The middle parent opts its own parent in, but its child does not
          // opt IT in — so the middle never fails and the flag stays inert.
          queue: 'p',
          spec: spec({ id: 'p', name: 'p', failParentOnFailure: true }),
          children: [{ queue: 'c', spec: spec({ id: 'c', name: 'c' }) }],
        },
      ],
    });

    await childFailed.promise;
    await sleep(100);
    expect(await transport.getJob('p', 'p')).toBeDefined();
    // The root must NOT fail: its child (the middle) never failed.
    expect(await transport.getJob('gp', 'gp')).toBeDefined();
  });

  it('re-runs a deduplicated id after the first instance settles, but not while active', async () => {
    const transport = make();
    let processCount = 0;
    const started = deferred<void>();
    const release = deferred<void>();
    let firstStarted = false;
    consume(transport, 'q', {
      process: async () => {
        processCount += 1;
        if (!firstStarted) {
          firstStarted = true;
          started.resolve();
          await release.promise;
        }
      },
    });

    await transport.enqueue('q', spec({ id: 'x', name: 'x' }));
    await started.promise; // 'x' is active and still in the map
    const dup = await transport.enqueue('q', spec({ id: 'x', name: 'x' }));
    expect(dup.jobId).toBe('x');
    await sleep(50);
    expect(processCount).toBe(1); // dedup while active: a no-op

    release.resolve();
    await waitFor(() => processCount === 1);
    await sleep(50);
    // 'x' has completed and left the map, so a re-enqueue runs again
    // (best-effort dedup, pinned to map membership).
    await transport.enqueue('q', spec({ id: 'x', name: 'x' }));
    await waitFor(() => processCount === 2);
    expect(processCount).toBe(2);
  });
});

/**
 * close() must clear every pending timer. These use fake timers so
 * `vi.getTimerCount()` can observe the leak directly: the transport clears its
 * timer set ONCE at the top of close(), so any timer scheduled during the
 * subsequent inflight drain (a retry backoff, or a flow-parent promotion whose
 * last child settles mid-drain) escapes the clear and survives close().
 */
describe('local transport — close() timer accounting', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function baseOptions(over: Partial<ConsumeOptions>): ConsumeOptions {
    return {
      isFinal: (err) => err instanceof Error && err.message === 'final',
      process: async () => undefined,
      onCompleted: () => undefined,
      onFailed: () => undefined,
      onError: () => undefined,
      ...over,
    };
  }

  it('clears the retry timer when close() lands in the backoff window', async () => {
    vi.useFakeTimers();
    const transport = createLocalTransport();
    let processCount = 0;
    const failedOnce = deferred<void>();
    transport.consume(
      'q',
      baseOptions({
        process: async () => {
          processCount += 1;
          throw new Error('retry');
        },
        onFailed: () => failedOnce.resolve(),
      }),
    );

    await transport.enqueue(
      'q',
      spec({
        id: 'r',
        name: 'x',
        attempts: 5,
        backoff: { type: 'fixed', delay: 30000 },
      }),
    );
    await failedOnce.promise;
    expect(processCount).toBe(1);
    expect(vi.getTimerCount()).toBe(1); // retry backoff timer parked

    await transport.close();
    expect(vi.getTimerCount()).toBe(0); // cleared cleanly
  });

  it('leaks a flow-parent promotion timer when the last child settles during the close drain', async () => {
    vi.useFakeTimers();
    const transport = createLocalTransport();
    let parentRan = false;
    const childStarted = deferred<void>();
    const childRelease = deferred<void>();
    transport.consume(
      'p',
      baseOptions({
        process: async () => {
          parentRan = true;
        },
      }),
    );
    transport.consume(
      'c',
      baseOptions({
        process: async () => {
          childStarted.resolve();
          await childRelease.promise;
        },
      }),
    );

    await transport.enqueueFlow({
      queue: 'p',
      spec: spec({ id: 'parent', name: 'parent', delay: 30000 }),
      children: [{ queue: 'c', spec: spec({ id: 'child', name: 'child' }) }],
    });
    await childStarted.promise;
    expect(vi.getTimerCount()).toBe(0);

    const closing = transport.close();
    childRelease.resolve(); // child completes inside the drain → promotes parent
    await closing;

    expect(parentRan).toBe(false); // no post-close dispatch (safety holds)
    expect(vi.getTimerCount()).toBe(0); // the 30s promotion timer must not survive
  });

  it('leaks a retry timer when an active attempt fails during the close drain', async () => {
    vi.useFakeTimers();
    const transport = createLocalTransport();
    let processCount = 0;
    const started = deferred<void>();
    const release = deferred<void>();
    transport.consume(
      'q',
      baseOptions({
        process: async () => {
          processCount += 1;
          started.resolve();
          await release.promise;
          throw new Error('retry');
        },
      }),
    );

    await transport.enqueue(
      'q',
      spec({
        id: 'r',
        name: 'x',
        attempts: 5,
        backoff: { type: 'fixed', delay: 30000 },
      }),
    );
    await started.promise;
    expect(vi.getTimerCount()).toBe(0);

    const closing = transport.close();
    release.resolve(); // attempt fails inside the drain → schedules retry timer
    await closing;

    expect(processCount).toBe(1); // no post-close retry dispatch
    expect(vi.getTimerCount()).toBe(0); // the retry timer must not survive
  });
});

function spec(
  over: Partial<TransportJobSpec> & { id: string; name: string },
): TransportJobSpec {
  return { data: {}, ...over };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(
  predicate: () => boolean,
  timeout = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error('local.test: waitFor timed out');
    }
    await sleep(15);
  }
}
