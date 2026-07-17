import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueFlow } from '../enqueue';
import { resolveNamespace } from '../namespace';
import {
  createQueueWorkerFromWorld,
  type QueueWorkerRuntime,
} from '../runtime';
import { task } from '../task';
import type { TaskDefinition } from '../types';
import type { OpenQueueWorld } from '../world';
import { worldLocal } from '../world-local';

/**
 * Integration matrix over the world seam: enqueue → execute → drain → runs,
 * schedule registration, cancel, and flows, driven through
 * `createQueueWorkerFromWorld` with real timers.
 *
 * Enqueue state is module-global today, so this file holds exactly ONE live
 * runtime (Stage D's `createEnqueuer` lifts that constraint). world-postgres
 * joins the table in Stage C.
 */
const flowOrder: string[] = [];

const echoTask = task({
  id: 'echo',
  queue: 'default',
  run: async (input) => ({ echoed: input }),
});

const childTask = task({
  id: 'flow-child',
  queue: 'flow-child',
  run: async () => {
    flowOrder.push('child');
  },
});

const parentTask = task({
  id: 'flow-parent',
  queue: 'flow-parent',
  run: async () => {
    flowOrder.push('parent');
  },
});

const tasks: TaskDefinition[] = [echoTask, childTask, parentTask];

const worlds: Array<[string, () => OpenQueueWorld]> = [
  ['local', () => worldLocal()({ namespace: resolveNamespace({}).namespace })],
];

describe.each(worlds)('world matrix — %s', (_name, buildWorld) => {
  let world: OpenQueueWorld;
  let runtime: QueueWorkerRuntime;

  beforeAll(async () => {
    world = buildWorld();
    runtime = await createQueueWorkerFromWorld(world, { tasks });
  });

  afterAll(async () => {
    await runtime.close();
  });

  it('resolves a string task id, executes it, and records the run', async () => {
    const result = await runtime.trigger('echo', { hello: 'world' });
    const run = await runtime.runs.poll(result.runId, {
      pollIntervalMs: 25,
      maxAttempts: 200,
    });

    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ echoed: { hello: 'world' } });

    const listed = await runtime.runs.list({ id: result.runId });
    expect(listed.data.map((entry) => entry.id)).toContain(result.runId);
  });

  it('registers a schedule tick and runs it on demand', async () => {
    const scheduleQueue = `${resolveNamespace({}).namespace}-queue-schedules`;
    const schedule = await runtime.schedules.create({
      task: 'echo',
      input: { tick: true },
      cron: '*/5 * * * *',
      deduplicationKey: 'world-matrix-echo',
      meta: { origin: 'world-matrix' },
    });

    const delayedAfterCreate = await world.transport.listDelayed(scheduleQueue);
    expect(delayedAfterCreate).toHaveLength(1);

    const triggered = await runtime.schedules.runNow(schedule.id);
    const run = await runtime.runs.poll(triggered.runId, {
      pollIntervalMs: 25,
      maxAttempts: 200,
    });
    expect(run.status).toBe('completed');
    expect(run.scheduleId).toBe(schedule.id);

    await runtime.schedules.delete(schedule.id);
    expect(await world.transport.listDelayed(scheduleQueue)).toHaveLength(0);
  });

  it('cancels a delayed run and drops its transport job', async () => {
    const result = await runtime.trigger(
      echoTask,
      { later: true },
      {
        delay: 5000,
      },
    );

    const before = await runtime.runs.retrieve(result.runId);
    expect(before?.status).toBe('delayed');

    const outcome = await runtime.runs.cancel(result.runId);
    expect(outcome.outcome).toBe('canceled');

    expect(
      await world.transport.getJob('default', result.transportJobId),
    ).toBeUndefined();
    const after = await runtime.runs.retrieve(result.runId);
    expect(after?.status).toBe('canceled');
  });

  it('runs flow children before the parent', async () => {
    flowOrder.length = 0;
    const result = await enqueueFlow({
      def: parentTask,
      input: {},
      children: [{ def: childTask, input: {} }],
    });

    const parent = await runtime.runs.poll(result.runId, {
      pollIntervalMs: 25,
      maxAttempts: 200,
    });
    expect(parent.status).toBe('completed');
    expect(flowOrder).toEqual(['child', 'parent']);
  });
});
