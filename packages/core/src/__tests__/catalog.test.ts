import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { task } from '../task';
import type { TaskDefinition } from '../types';

const bullmq = vi.hoisted(() => {
  class QueueMock {
    static instances: QueueMock[] = [];
    adds: Array<{ name: string; data: unknown; opts: { jobId?: string } }> = [];

    constructor(
      readonly name: string,
      readonly opts: unknown,
    ) {
      QueueMock.instances.push(this);
    }

    async add(name: string, data: unknown, opts: { jobId?: string }) {
      this.adds.push({ name, data, opts });
      return {
        id: opts.jobId,
        name,
        queueName: this.name,
        data,
        opts,
        timestamp: 1,
        attemptsMade: 0,
      };
    }

    async close() {}
  }

  return { QueueMock };
});

vi.mock('bullmq', () => ({
  Queue: bullmq.QueueMock,
  FlowProducer: class {},
}));

class RedisMock {
  private hashes = new Map<string, Record<string, string>>();
  private values = new Map<string, string>();

  async del(key: string) {
    this.hashes.delete(key);
    this.values.delete(key);
  }

  async hset(
    key: string,
    field: string | Record<string, string>,
    value?: string,
  ) {
    const current = this.hashes.get(key) ?? {};
    if (typeof field === 'string') {
      this.hashes.set(key, { ...current, [field]: value ?? '' });
      return;
    }
    this.hashes.set(key, { ...current, ...field });
  }

  async hget(key: string, field: string) {
    return this.hashes.get(key)?.[field] ?? null;
  }

  async hgetall(key: string) {
    return this.hashes.get(key) ?? {};
  }

  async hdel(key: string, ...fields: string[]) {
    const current = this.hashes.get(key);
    if (!current) return 0;
    let count = 0;
    for (const field of fields) {
      if (field in current) {
        delete current[field];
        count++;
      }
    }
    this.hashes.set(key, current);
    return count;
  }

  async set(key: string, value: string) {
    this.values.set(key, value);
  }

  async quit() {}
}

function job(
  input: Partial<TaskDefinition> & { name: string },
): TaskDefinition {
  return {
    id: input.id ?? input.name,
    name: input.name,
    queue: input.queue ?? input.name,
    handler: async () => undefined,
    concurrency: input.concurrency ?? 1,
    attempts: input.attempts ?? 1,
    backoff: input.backoff ?? { type: 'fixed', delay: 1 },
    tags: input.tags ?? [],
    description: input.description,
    cron: input.cron,
    ttl: input.ttl,
  };
}

describe('queue catalog', () => {
  beforeEach(() => {
    bullmq.QueueMock.instances.length = 0;
  });

  it('publishes and reads catalog metadata', async () => {
    const { publishQueueCatalog, readQueueCatalog, resolveQueueCatalogTask } =
      await import('../catalog.js');
    const redis = new RedisMock();

    await publishQueueCatalog(redis as never, [
      job({
        name: 'process-document',
        queue: 'documents',
        attempts: 4,
        cron: '0 * * * *',
        description: 'Process an inbox document',
        tags: ['inbox'],
      }),
    ]);

    const [entry] = await readQueueCatalog(redis as never);

    expect(entry).toMatchObject({
      id: 'process-document',
      name: 'process-document',
      queue: 'documents',
      attempts: 4,
      cron: '0 * * * *',
      description: 'Process an inbox document',
      tags: ['inbox'],
    });
    await expect(
      resolveQueueCatalogTask(redis as never, 'process-document'),
    ).resolves.toMatchObject({ queue: 'documents' });
  });

  it('does not publish payload defaults in the catalog', async () => {
    const { publishQueueCatalog, readQueueCatalog } = await import(
      '../catalog.js'
    );
    const redis = new RedisMock();

    await publishQueueCatalog(redis as never, [
      task({
        id: 'send-message',
        schema: z.object({ message: z.string().default('Hello') }),
        run: async () => undefined,
      }) as unknown as TaskDefinition,
    ]);

    const [entry] = await readQueueCatalog(redis as never);
    expect(entry).toMatchObject({ id: 'send-message' });
    expect(Object.hasOwn(entry!, 'sample')).toBe(false);
  });

  it('replaces catalog entries when metadata changes', async () => {
    const { publishQueueCatalog, resolveQueueCatalogTask } = await import(
      '../catalog.js'
    );
    const redis = new RedisMock();

    await publishQueueCatalog(redis as never, [
      job({ name: 'sync-bank-account', queue: 'banking', attempts: 1 }),
    ]);
    await publishQueueCatalog(redis as never, [
      job({ name: 'sync-bank-account', queue: 'banking', attempts: 5 }),
    ]);

    await expect(
      resolveQueueCatalogTask(redis as never, 'sync-bank-account'),
    ).resolves.toMatchObject({ attempts: 5 });
  });

  it('keeps catalogs isolated by namespace on the same Redis', async () => {
    const { publishQueueCatalog, readQueueCatalog, resolveQueueCatalogTask } =
      await import('../catalog.js');
    const redis = new RedisMock();

    await publishQueueCatalog(
      redis as never,
      [job({ name: 'sync-bank-account', queue: 'banking' })],
      [],
      'app-a',
    );
    await publishQueueCatalog(
      redis as never,
      [job({ name: 'sync-bank-account', queue: 'integrations' })],
      [],
      'app-b',
    );

    await expect(
      readQueueCatalog(redis as never, 'app-a'),
    ).resolves.toMatchObject([{ queue: 'banking' }]);
    await expect(
      readQueueCatalog(redis as never, 'app-b'),
    ).resolves.toMatchObject([{ queue: 'integrations' }]);
    await expect(
      resolveQueueCatalogTask(redis as never, 'sync-bank-account', 'app-a'),
    ).resolves.toMatchObject({ queue: 'banking' });
  });

  it('throws a clear error for unknown task ids', async () => {
    const { resolveQueueCatalogTask } = await import('../catalog.js');

    await expect(
      resolveQueueCatalogTask(new RedisMock() as never, 'missing-task'),
    ).rejects.toThrow(
      'Unknown task "missing-task"; worker catalog has not been published',
    );
  });

  it('producer client resolves task id routing from the catalog', async () => {
    const { createQueueClient, publishQueueCatalog } = await import(
      '../index.js'
    );
    const redis = new RedisMock();
    await publishQueueCatalog(redis as never, [
      job({ name: 'process-document', queue: 'documents', attempts: 2 }),
    ]);

    const client = createQueueClient({ redis: redis as never });
    const result = await client.trigger(
      'process-document',
      { documentId: 'doc-1' },
      { jobId: 'run-1' },
    );

    const queue = bullmq.QueueMock.instances.find(
      (item) => item.name === 'documents',
    )!;
    expect(result).toMatchObject({
      id: 'run-1',
      runId: 'run-1',
      jobId: 'run-1',
      transportJobId: 'run-1',
    });
    expect(queue.name).toBe('documents');
    expect(queue.adds[0]).toMatchObject({
      name: 'process-document',
      opts: { jobId: 'run-1', attempts: 2 },
      data: { __runId: 'run-1' },
    });
  });

  it('enqueues schema-derived defaults and freeform input', async () => {
    const { configureEnqueue, enqueue } = await import('../enqueue.js');
    configureEnqueue({ redis: new RedisMock() as never });

    const typed = task({
      id: 'typed',
      schema: z.object({ message: z.string().default('Hello') }),
      run: async () => undefined,
    });
    const freeform = task({
      id: 'freeform',
      queue: 'system',
      run: async () => undefined,
    });

    await enqueue(
      typed as unknown as TaskDefinition<unknown, unknown>,
      {},
      { jobId: 'typed-run' },
    );
    await enqueue(freeform, { anything: true }, { jobId: 'freeform-run' });

    const typedQueue = bullmq.QueueMock.instances.find(
      (item) => item.name === 'typed',
    )!;
    const systemQueue = bullmq.QueueMock.instances.find(
      (item) => item.name === 'system',
    )!;

    expect(typedQueue.adds[0]?.data).toMatchObject({
      __input: { message: 'Hello' },
    });
    expect(systemQueue.adds[0]?.data).toMatchObject({
      __input: { anything: true },
    });
  });

  it('producer client falls back to configured durable catalog stores', async () => {
    const { createQueueClient, memoryQueueCatalogStore, taskCatalogEntry } =
      await import('../index.js');
    const redis = new RedisMock();
    const store = memoryQueueCatalogStore([
      taskCatalogEntry(
        job({
          name: 'export-transactions',
          queue: 'transactions',
          attempts: 3,
        }),
      ),
    ]);

    const client = createQueueClient({ redis: redis as never, catalog: store });
    await client.trigger(
      'export-transactions',
      { accountId: 'acct-1' },
      { jobId: 'fallback-run' },
    );

    const queue = bullmq.QueueMock.instances.find(
      (item) => item.name === 'transactions',
    )!;
    expect(queue.name).toBe('transactions');
    expect(queue.adds[0]).toMatchObject({
      name: 'export-transactions',
      opts: { jobId: 'fallback-run', attempts: 3 },
    });
  });
});
