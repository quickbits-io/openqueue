import { type ConnectionOptions, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { bullPrefix, type NamespaceOptions } from './namespace';
import type { QueueDefinition, QueueDefinitionInput } from './types';

export const defaultJobOptions = {
  removeOnComplete: { age: 7 * 24 * 3600, count: 20_000 },
  removeOnFail: { age: 30 * 24 * 3600, count: 5_000 },
};

export function queue(input: QueueDefinitionInput): QueueDefinition {
  return {
    name: input.name,
    concurrency: input.concurrency,
  };
}

export function createQueue(
  name: string,
  connection: Redis,
  options: NamespaceOptions = {},
): Queue {
  return new Queue(name, {
    connection: connection as unknown as ConnectionOptions,
    prefix: bullPrefix(options),
    defaultJobOptions,
  });
}
