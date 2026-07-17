import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { resolveNamespace } from '../namespace';
import { createQueueWorker } from '../runtime';
import { task } from '../task';
import type { TaskDefinition } from '../types';
import { worldBullmq } from '../world-bullmq';
import { worldLocal } from '../world-local';

/**
 * The public world surface Stage C froze: `createQueueWorker({ world })` boots a
 * runtime off a caller-supplied {@link WorldFactory} instead of a Redis URL. The
 * local world exercises the whole path with no external services; the
 * redis-gated block proves the `worldBullmq({ url })` ownership contract —
 * `close()` quits the clients the world minted for itself.
 */
describe('createQueueWorker({ world }) — public world surface', () => {
  it('triggers a task, records the completed run, and syncs declarative schedules', async () => {
    const echo = task({
      id: `world-public-echo-${randomUUID()}`,
      queue: 'default',
      run: async (input) => ({ echoed: input }),
    });
    const ticker = task({
      id: `world-public-tick-${randomUUID()}`,
      queue: 'default',
      cron: '*/5 * * * *',
      run: async () => undefined,
    });

    const runtime = await createQueueWorker({
      world: worldLocal(),
      tasks: [echo, ticker] as TaskDefinition[],
    });

    try {
      const { runId } = await runtime.trigger(echo.id, { hello: 'world' });
      const run = await runtime.runs.poll(runId, {
        pollIntervalMs: 25,
        maxAttempts: 200,
      });
      expect(run.status).toBe('completed');
      expect(run.output).toEqual({ echoed: { hello: 'world' } });

      const completed = await runtime.runs.list({ status: 'completed' });
      expect(completed.data.map((entry) => entry.id)).toContain(runId);

      const declarative = await runtime.schedules.list({
        meta: { scheduleType: 'declarative' },
      });
      expect(declarative.map((schedule) => schedule.task)).toContain(ticker.id);
    } finally {
      await runtime.close();
    }
  });
});

const redisUrl = process.env.REDIS_URL;

describe.skipIf(!redisUrl)(
  'worldBullmq({ url }) ownership (real redis)',
  () => {
    it('quits the clients it created internally on close', async () => {
      const monitor = new Redis(redisUrl ?? 'redis://localhost:6380', {
        maxRetriesPerRequest: null,
      });
      try {
        await monitor.ping();
        const baseline = await connectedClients(monitor);

        const namespace = resolveNamespace({
          namespace: `world-own-${randomUUID()}`,
        });
        const world = worldBullmq({
          url: redisUrl ?? 'redis://localhost:6380',
        })({ namespace });

        // Enqueue forces the internally-created producer to connect.
        await world.transport.enqueue('world-own-queue', {
          id: `own-${randomUUID()}`,
          name: 'own',
          data: {},
        });
        expect(await connectedClients(monitor)).toBeGreaterThan(baseline);

        await world.close();
        await waitUntil(
          async () => (await connectedClients(monitor)) <= baseline,
        );
        expect(await connectedClients(monitor)).toBe(baseline);
      } finally {
        await monitor.quit().catch(() => undefined);
      }
    });
  },
);

async function connectedClients(redis: Redis): Promise<number> {
  const info = await redis.info('clients');
  const match = info.match(/connected_clients:(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
