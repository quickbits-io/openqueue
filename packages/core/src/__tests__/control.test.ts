import { describe, expect, it } from 'vitest';
import { catalogEntryDefinition } from '../catalog';
import { createControlRuntime } from '../control';
import { enqueue } from '../enqueue';
import { resolveNamespace } from '../namespace';
import { InvalidScheduleError, UnknownTaskError } from '../request-errors';
import { scheduleQueueNameFor, scheduleTickJobName } from '../schedules';
import type { QueueDrain, QueueDrainEvent } from '../types';
import type {
  OpenQueueWorld,
  WorldFactory,
  WorldMigrationState,
} from '../world';
import { worldLocal } from '../world-local';
import { catalogEntry } from './support/memory-storage';

function seededWorld(namespace?: string): OpenQueueWorld {
  const world = worldLocal()({
    namespace: resolveNamespace({ namespace }).namespace,
  });
  return world;
}

function recordingDrain(): { drain: QueueDrain; events: QueueDrainEvent[] } {
  const events: QueueDrainEvent[] = [];
  return {
    events,
    drain: {
      name: 'test',
      handle: async (event) => {
        events.push(event);
      },
    },
  };
}

/** A worldLocal wrapped with a stub migration probe of the given step states. */
function migratingWorld(states: WorldMigrationState[]): WorldFactory {
  return (ctx) => ({
    ...worldLocal()(ctx),
    migrations: {
      steps: states.map((_, i) => ({ id: `m${i}`, checksum: 'c', sql: '' })),
      status: async () => states.map((state, i) => ({ id: `m${i}`, state })),
    },
  });
}

describe('createControlRuntime', () => {
  it('triggers a task by catalog id and records a queued run with no consumer', async () => {
    const world = seededWorld();
    await world.store.publish([catalogEntry('echo')]);
    const runtime = await createControlRuntime(() => world);

    const { runId } = await runtime.trigger('echo', { hello: true });
    const run = await runtime.runs.retrieve(runId);
    expect(run?.status).toBe('queued');

    await runtime.close();
  });

  it('lists, retrieves, and cancels a queued run', async () => {
    const world = seededWorld();
    await world.store.publish([catalogEntry('echo')]);
    const runtime = await createControlRuntime(() => world);

    const { runId } = await runtime.trigger(
      'echo',
      { hello: true },
      { delay: 60_000 },
    );

    const listed = await runtime.runs.list({ id: runId });
    expect(listed.data[0]?.id).toBe(runId);

    const canceled = await runtime.runs.cancel(runId);
    expect(canceled.outcome).toBe('canceled');
    const after = await runtime.runs.retrieve(runId);
    expect(after?.status).toBe('canceled');

    await runtime.close();
  });

  it('creates a schedule and enqueues a delayed tick on the world transport', async () => {
    const world = seededWorld('ctrl-sched');
    await world.store.publish([catalogEntry('echo')]);
    const runtime = await createControlRuntime(() => world, {
      namespace: 'ctrl-sched',
    });

    const schedule = await runtime.schedules.create({
      task: 'echo',
      cron: '*/5 * * * *',
      input: { hi: true },
      deduplicationKey: 'ctrl-sched-1',
    });
    expect(schedule.task).toBe('echo');

    const delayed = await world.transport.listDelayed(
      scheduleQueueNameFor('ctrl-sched'),
    );
    expect(delayed.some((handle) => handle.name === scheduleTickJobName)).toBe(
      true,
    );

    await runtime.close();
  });

  it('isolates drains across two control runtimes in one module, in both directions', async () => {
    const a = recordingDrain();
    const b = recordingDrain();
    const worldA = seededWorld('iso-a');
    const worldB = seededWorld('iso-b');
    await worldA.store.publish([catalogEntry('echo')]);
    await worldB.store.publish([catalogEntry('echo')]);

    const runtimeA = await createControlRuntime(() => worldA, {
      namespace: 'iso-a',
      drains: [a.drain],
    });
    const runtimeB = await createControlRuntime(() => worldB, {
      namespace: 'iso-b',
      drains: [b.drain],
    });

    await runtimeA.trigger('echo', { n: 1 });

    expect(a.events.some((event) => event.type === 'enqueue')).toBe(true);
    // The B runtime's drain never sees A's enqueue — the fix Stage B could not
    // deliver with a single module-global enqueuer.
    expect(b.events).toHaveLength(0);

    // Reverse direction: B's activity must not leak into A's drain either.
    const aEventsAfterA = a.events.length;
    await runtimeB.trigger('echo', { n: 2 });
    expect(b.events.some((event) => event.type === 'enqueue')).toBe(true);
    expect(a.events).toHaveLength(aEventsAfterA);

    await runtimeA.close();
    await runtimeB.close();
  });

  it('does not mutate the process-global enqueue facade', async () => {
    const runtime = await createControlRuntime(() => seededWorld());

    // createControlRuntime must never call configureEnqueueTransport, so the
    // bare module-global enqueue() stays unconfigured. This is the property that
    // keeps two control planes in one process — and Workers isolates — from
    // sharing state through the default enqueuer. (The facade asserts its
    // transport synchronously, so this throws rather than rejects.)
    expect(() =>
      enqueue(catalogEntryDefinition(catalogEntry('echo')), { hi: true }),
    ).toThrow('enqueue() called before the transport was configured');

    await runtime.close();
  });

  it('throws the exact catalog-miss error when triggering an unknown task id (worker-path parity)', async () => {
    const runtime = await createControlRuntime(() => seededWorld());

    await expect(runtime.trigger('ghost', { hi: true })).rejects.toThrow(
      'Unknown task "ghost"; worker catalog has not been published',
    );

    await runtime.close();
  });

  it('resolves an unknown catalog id to undefined (POST /jobs answers task_not_found, not 500)', async () => {
    const runtime = await createControlRuntime(() => seededWorld());

    // catalog.resolve follows the QueueCatalogStore contract (miss → undefined);
    // only trigger stays strict and throws.
    await expect(runtime.catalog.resolve('ghost')).resolves.toBeUndefined();

    await runtime.close();
  });

  it('throws typed validation errors from schedules.create (wire-mappable, not internal)', async () => {
    const world = seededWorld();
    await world.store.publish([catalogEntry('echo')]);
    const runtime = await createControlRuntime(() => world);

    await expect(
      runtime.schedules.create({
        task: 'echo',
        cron: 'not a cron',
        deduplicationKey: 'k1',
      }),
    ).rejects.toBeInstanceOf(InvalidScheduleError);

    await expect(
      runtime.schedules.create({
        task: 'ghost',
        cron: '* * * * *',
        deduplicationKey: 'k2',
      }),
    ).rejects.toBeInstanceOf(UnknownTaskError);

    await runtime.close();
  });

  it('constructs over a world without migrations', async () => {
    const runtime = await createControlRuntime(() => seededWorld());
    expect(typeof runtime.trigger).toBe('function');
    expect(typeof runtime.close).toBe('function');
    await runtime.close();
  });

  it('constructs when every migration is applied', async () => {
    const runtime = await createControlRuntime(
      migratingWorld(['applied', 'applied']),
    );
    expect(typeof runtime.trigger).toBe('function');
    await runtime.close();
  });

  it('throws an actionable error when a migration is pending', async () => {
    await expect(
      createControlRuntime(migratingWorld(['applied', 'pending'])),
    ).rejects.toThrow(/1 pending migration\(s\).*never applies DDL/s);
  });

  it('throws an actionable error naming the step when a migration checksum mismatches', async () => {
    const error = await createControlRuntime(
      migratingWorld(['applied', 'checksum_mismatch']),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toMatch(/never applies DDL/);
      // The message names the offending step id (m1), not just a count.
      expect(error.message).toContain('m1');
    }
  });

  it('closes the world when the migration gate fails, releasing the connection', async () => {
    let closed = false;
    const world: WorldFactory = (ctx) => ({
      ...worldLocal()(ctx),
      migrations: {
        steps: [{ id: 'm0', checksum: 'c', sql: '' }],
        status: async () => [{ id: 'm0', state: 'pending' }],
      },
      close: async () => {
        closed = true;
      },
    });

    await expect(createControlRuntime(world)).rejects.toThrow(
      /never applies DDL/,
    );
    // The gate opened the world to probe migrations; a failed gate must release
    // it so a recovering caller does not leak the connection (deviation 4).
    expect(closed).toBe(true);
  });
});
