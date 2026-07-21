import { describe, expect, it } from 'vitest';
import { resolveNamespace } from '../namespace';
import { worldLocal } from '../world-local';

/**
 * The memory schedule store keys dedupe in a side map (the Redis/Postgres stores
 * keep it on the row). When a schedule's `deduplicationKey` changes, the old key
 * must stop pointing at it — otherwise a later create with the old key patches
 * the moved schedule instead of creating a new one.
 */
describe('memory schedule store — deduplication key changes', () => {
  it('drops the old dedupe key so it no longer patches the schedule after a change', async () => {
    const store = worldLocal()({
      namespace: resolveNamespace({}).namespace,
    }).store.schedules;

    await store.create({
      id: 'sched-a',
      task: 'echo',
      cron: '* * * * *',
      timezone: 'UTC',
      deduplicationKey: 'key-1',
      nextRunAt: new Date(),
    });
    await store.update('sched-a', { deduplicationKey: 'key-2' });

    // Reusing the OLD key must make a NEW schedule, not silently patch sched-a
    // through the stale mapping.
    const created = await store.create({
      id: 'sched-b',
      task: 'echo',
      cron: '* * * * *',
      timezone: 'UTC',
      deduplicationKey: 'key-1',
      nextRunAt: new Date(),
    });

    expect(created.id).toBe('sched-b');
    expect((await store.list()).map((schedule) => schedule.id).sort()).toEqual([
      'sched-a',
      'sched-b',
    ]);
  });
});
