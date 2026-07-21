import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ActiveTransportJob,
  ConsumeOptions,
  TransportConsumer,
} from '../transport/types';
import type { TaskDefinition } from '../types';
import { createWorkerConsumers } from '../worker';

/**
 * The attempt span must report the *active* transport as `messaging.system`.
 * `runJob` is transport-neutral, so a job delivered by `worldPostgres` /
 * `worldLocal` must not be mislabeled as `bullmq`.
 */
const exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider;

beforeEach(() => {
  exporter.reset();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
});

function echoTask(): TaskDefinition {
  return {
    id: 'echo',
    name: 'echo',
    queue: 'default',
    handler: async () => 'ok',
    concurrency: 1,
    attempts: 1,
    backoff: { type: 'fixed', delay: 0 },
    tags: [],
  };
}

function activeJob(): ActiveTransportJob {
  return {
    id: 'job-1',
    name: 'echo',
    queueName: 'default',
    data: { __runId: 'run-1', __input: {}, __meta: {}, __metadata: {} },
    timestamp: Date.now(),
    attemptsMade: 0,
    returnvalue: undefined,
    opts: { attempts: 1 },
    updateData: async () => undefined,
    updateProgress: async () => undefined,
    log: async () => undefined,
  };
}

/**
 * A transport stub that records the `ConsumeOptions` the worker registers and
 * lets the test drive a single job through the real `process` path.
 */
function stubTransport(id: string) {
  let options: ConsumeOptions | undefined;
  return {
    id,
    consume(_queue: string, opts: ConsumeOptions): TransportConsumer {
      options = opts;
      return { close: async () => undefined };
    },
    run(job: ActiveTransportJob): Promise<unknown> {
      if (!options) throw new Error('consume was not called');
      return options.process(job);
    },
  };
}

describe('runJob attempt span', () => {
  it('stamps messaging.system with the transport id', async () => {
    const transport = stubTransport('postgres');
    createWorkerConsumers([echoTask()], transport);

    await transport.run(activeJob());
    await provider.forceFlush();

    const attempt = exporter
      .getFinishedSpans()
      .find((span) => span.name.startsWith('Attempt'));
    expect(attempt?.attributes['messaging.system']).toBe('postgres');
  });
});
