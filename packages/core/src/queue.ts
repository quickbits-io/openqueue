import type { QueueDefinition, QueueDefinitionInput } from './types';

export function queue(input: QueueDefinitionInput): QueueDefinition {
  return {
    name: input.name,
    concurrency: input.concurrency,
  };
}
