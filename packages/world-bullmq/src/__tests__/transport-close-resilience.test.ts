import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createBullmqTransport } from '../transport';

const url = process.env.REDIS_URL;

/**
 * `transport.close()` drains the workers it spawned before tearing down
 * producers. A single worker's `close()` rejecting must not strand the queues,
 * FlowProducer, and transport-owned consumer — those Redis handles would leak on
 * shutdown. The transport settles every phase and rethrows the first failure
 * only after everything is closed.
 */
describe.skipIf(!url)('bullmq transport.close resilience (real redis)', () => {
  const producer = new Redis(url ?? 'redis://localhost:6380', {
    maxRetriesPerRequest: null,
  });
  // Injected so the transport leaves it open; the worker is drained through it,
  // avoiding the reconnect noise a transport-quit owned consumer would emit.
  const consumer = new Redis(url ?? 'redis://localhost:6380', {
    maxRetriesPerRequest: null,
  });

  afterAll(async () => {
    await producer.quit().catch(() => undefined);
    await consumer.quit().catch(() => undefined);
  });

  it('closes the queues even when a spawned worker close rejects', async () => {
    const namespace = `tclose-fail-${randomUUID().slice(0, 8)}`;
    const transport = createBullmqTransport({ producer, consumer, namespace });
    const queueName = `${namespace}-q`;

    const { worker } = transport.consume(queueName, {
      isFinal: () => false,
      process: async () => 'ok',
      onCompleted: () => undefined,
      onFailed: () => undefined,
      onError: () => undefined,
    });
    // Let the worker's blocking connection finish initializing before closing.
    // Closing mid-init flushes its in-flight version-check INFO after
    // RedisConnection.close() has already removed the connection's error
    // forwarder; the constructor's `initializing.catch(err => emit('error'))`
    // then throws on the listener-less emitter, leaking an unhandled
    // 'Connection is closed.' rejection (flaky on slow CI runners).
    await worker.waitUntilReady();

    // Touch the queue so it lands in the transport's queue map.
    await transport.enqueue(queueName, { id: 'j1', name: 'work', data: {} });
    const queue = transport.queue(queueName);
    const queueClose = vi.spyOn(queue, 'close');

    // The transport's internal consumer close is `() => worker.close()`. Drain
    // the worker for real (so no Redis handle dangles) but report the close as
    // rejected: without the allSettled fix that rejection short-circuits
    // transport.close() and the queues below are never torn down.
    const drainWorker = worker.close.bind(worker);
    vi.spyOn(worker, 'close').mockImplementationOnce(async () => {
      await drainWorker();
      throw new Error('worker close boom');
    });

    await expect(transport.close()).rejects.toThrow('worker close boom');
    expect(queueClose).toHaveBeenCalled();

    // The injected connections belong to the caller — left open, still usable.
    expect(producer.status).not.toBe('end');
    expect(await producer.ping()).toBe('PONG');
  });
});
