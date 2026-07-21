import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { isBullmqTransport } from '../transport';
import { worldBullmq } from '../world';

const url = process.env.REDIS_URL;

/**
 * `world.close()` must quit the Redis clients the world owns even when the
 * transport close rejects — otherwise a failing shutdown strands the duplicated
 * blocking consumer. The failure still surfaces after cleanup, and the caller's
 * injected producer is never touched.
 */
describe.skipIf(!url)('worldBullmq close resilience (real redis)', () => {
  const producer = new Redis(url ?? 'redis://localhost:6380', {
    maxRetriesPerRequest: null,
  });

  afterAll(async () => {
    await producer.quit().catch(() => undefined);
  });

  it('quits the owned consumer and rethrows when transport close fails', async () => {
    const namespace = `wclose-fail-${randomUUID().slice(0, 8)}`;

    // Capture the world-owned duplicate so its teardown is observable.
    let owned: Redis | undefined;
    const originalDuplicate = producer.duplicate.bind(producer);
    const duplicateSpy = vi
      .spyOn(producer, 'duplicate')
      .mockImplementation((override) => {
        owned = originalDuplicate(override);
        return owned;
      });

    try {
      const world = worldBullmq({ producer })({ namespace });
      if (!isBullmqTransport(world.transport)) {
        throw new Error('expected a bullmq transport');
      }
      const consumer = world.transport.consume(`${namespace}-q`, {
        isFinal: () => false,
        process: async () => 'ok',
        onCompleted: () => undefined,
        onFailed: () => undefined,
        onError: () => undefined,
      });
      expect(owned).toBeDefined();

      vi.spyOn(consumer.worker, 'close').mockRejectedValue(new Error('boom'));

      await expect(world.close()).rejects.toThrow('boom');
      // The world-owned duplicated consumer was still quit (quit settles after
      // the in-flight connect completes, so wait for the terminal status).
      await vi.waitFor(() => expect(owned?.status).toBe('end'), {
        timeout: 3000,
      });
      // …and the caller's producer stays open.
      await expect(producer.ping()).resolves.toBe('PONG');
    } finally {
      duplicateSpy.mockRestore();
      await owned?.quit().catch(() => undefined);
    }
  });
});
