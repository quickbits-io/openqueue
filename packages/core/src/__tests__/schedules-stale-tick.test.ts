import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createQueueSchedulesWithTransport,
  scheduleQueueNameFor,
  scheduleTickJobName,
} from '../schedules';
import { createBullmqTransport } from '../transport/bullmq';
import type { TransportJobHandle } from '../transport/types';
import { catalogEntry, memoryStorage } from './support/memory-storage';

const url = process.env.REDIS_URL;

/**
 * Real-Redis assertion that the refactored `removeScheduleJob`
 * (getJob + listDelayed + scheduleTickMatches → remove, all via the transport)
 * still replaces a schedule's stale delayed tick on update and clears it on
 * deactivate — the property the mocked schedules suite and the e2e schedule
 * test exercise but never assert on the delayed set.
 */
describe.skipIf(!url)('schedule stale-tick removal (real redis)', () => {
  const namespace = `sched-${randomUUID().slice(0, 8)}`;
  const connection = new Redis(url ?? 'redis://localhost:6380', {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
  const transport = createBullmqTransport({ producer: connection, namespace });
  const queueName = scheduleQueueNameFor(namespace);

  afterAll(async () => {
    await transport.close();
    await connection.quit().catch(() => undefined);
  });

  function scheduledAtOf(handle: TransportJobHandle): string | undefined {
    if (handle.name !== scheduleTickJobName) return undefined;
    const input = (
      handle.data as {
        __input?: { scheduleId?: unknown; scheduledAt?: unknown };
      }
    )?.__input;
    return typeof input?.scheduledAt === 'string'
      ? input.scheduledAt
      : undefined;
  }

  async function ticksFor(scheduleId: string): Promise<string[]> {
    const delayed = await transport.listDelayed(queueName);
    return delayed
      .filter((handle) => {
        const input = (handle.data as { __input?: { scheduleId?: unknown } })
          ?.__input;
        return (
          handle.name === scheduleTickJobName &&
          input?.scheduleId === scheduleId
        );
      })
      .map((handle) => scheduledAtOf(handle))
      .filter((at): at is string => typeof at === 'string');
  }

  it('replaces the stale tick on update and clears it on deactivate', async () => {
    const storage = memoryStorage();
    const controller = createQueueSchedulesWithTransport({
      transport,
      storage,
      resolveTask: async () => catalogEntry('echo'),
      trigger: async () => ({
        id: 'run',
        runId: 'run',
        jobId: 'run',
        transportJobId: 'run',
      }),
      namespace,
    });

    const created = await controller.create({
      task: 'echo',
      cron: '*/5 * * * *',
      deduplicationKey: `stale-${randomUUID()}`,
    });

    const afterCreate = await ticksFor(created.id);
    expect(afterCreate).toHaveLength(1);
    const firstScheduledAt = afterCreate[0];

    // A markedly different cron guarantees a different scheduledAt and thus a
    // different tick jobId — so a broken remove would leave two ticks, not one.
    await controller.update(created.id, { cron: '0 0 1 1 *' });

    const afterUpdate = await ticksFor(created.id);
    expect(afterUpdate).toHaveLength(1);
    expect(afterUpdate[0]).not.toBe(firstScheduledAt);

    await controller.deactivate(created.id);
    expect(await ticksFor(created.id)).toHaveLength(0);
  });
});
