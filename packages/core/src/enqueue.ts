import { randomUUID } from 'node:crypto';
import {
  type ConnectionOptions,
  FlowProducer,
  type JobsOptions,
  type Queue,
} from 'bullmq';
import type { Redis } from 'ioredis';
import { composeDrains } from './compose';
import { serializeError } from './errors';
import {
  bullPrefix,
  DEFAULT_NAMESPACE,
  type NamespaceOptions,
  resolveNamespace,
} from './namespace';
import { captureTraceCarrier, startRunSpan } from './otel-hooks';
import { createQueue, defaultJobOptions } from './queue';
import { bindQueueRuntime } from './task';
import type {
  EnqueueOptions,
  EnqueueResult,
  FlowChildSpec,
  FlowParentSpec,
  FlowTaskDefinition,
  QueueDrain,
  QueueRunSnapshot,
  RunStatus,
  TaskDefinition,
} from './types';

const queues = new Map<string, Queue>();
let flowProducer: FlowProducer | null = null;
let sharedDrain: QueueDrain = composeDrains();
let sharedRedis: Redis | null = null;
let sharedNamespace = DEFAULT_NAMESPACE;
let sharedBullPrefix: string | undefined;

export function configureEnqueue(
  opts: {
    redis: Redis;
    drain?: QueueDrain;
    drains?: QueueDrain[];
  } & NamespaceOptions,
): void {
  const namespace = resolveNamespace(opts);
  sharedRedis = opts.redis;
  sharedNamespace = namespace.namespace;
  sharedBullPrefix = namespace.bullPrefix;
  sharedDrain = composeDrains(sharedDrain, opts.drain, ...(opts.drains ?? []));
  bindQueueRuntime({
    trigger: async (target, input, triggerOpts) => {
      if (typeof target === 'string') {
        throw new Error(
          `@openqueue/sdk: Unknown task "${target}"; worker catalog has not been published`,
        );
      }
      return enqueue(target, input, triggerOpts);
    },
  });
}

function assertRedis(): Redis {
  if (!sharedRedis) {
    throw new Error(
      '@openqueue/sdk: enqueue() called before configureEnqueue({ redis, drains? }). Call it at process boot.',
    );
  }
  return sharedRedis;
}

function getQueue(name: string): Queue {
  const key = `${sharedBullPrefix}:${sharedNamespace}:${name}`;
  const existing = queues.get(key);
  if (existing) return existing;
  const queue = createQueue(name, assertRedis(), {
    namespace: sharedNamespace,
    bullPrefix: sharedBullPrefix,
  });
  queues.set(key, queue);
  return queue;
}

function getFlowProducer(): FlowProducer {
  if (!flowProducer) {
    flowProducer = new FlowProducer({
      connection: assertRedis() as unknown as ConnectionOptions,
      prefix: bullPrefix({
        namespace: sharedNamespace,
        bullPrefix: sharedBullPrefix,
      }),
    });
  }
  return flowProducer;
}

function buildJobData<I>(
  input: I,
  runId: string,
  taskName: string,
  opts?: EnqueueOptions,
) {
  const meta = opts?.meta ?? {};
  const derived = new Set<string>(meta.tags ?? []);
  derived.add(`run:${runId}`);
  const carrier =
    captureTraceCarrier() ??
    startRunSpan(`run.${taskName}`, {
      'task.name': taskName,
      'run.id': runId,
    });
  return {
    __input: input,
    __runId: runId,
    __meta: { ...meta, tags: Array.from(derived) },
    __metadata: {},
    ...(carrier ? { __otel: carrier } : {}),
  };
}

type QueueJobData = ReturnType<typeof buildJobData>;

function buildJobOptions(
  def: Pick<TaskDefinition<unknown, unknown>, 'attempts' | 'backoff' | 'ttl'>,
  runId: string,
  opts?: EnqueueOptions,
): JobsOptions {
  return {
    jobId: opts?.jobId ?? runId,
    delay: opts?.delay,
    priority: opts?.priority,
    attempts: opts?.attempts ?? def.attempts,
    backoff: opts?.backoff ?? def.backoff,
    ttl: opts?.ttl ?? def.ttl,
    failParentOnFailure: opts?.failParentOnFailure,
    continueParentOnFailure: opts?.continueParentOnFailure,
    ignoreDependencyOnFailure: opts?.ignoreDependencyOnFailure,
  } as JobsOptions;
}

function enqueueStatus(opts: JobsOptions, hasChildren = false): RunStatus {
  if (hasChildren) return 'waiting_children';
  return opts.delay ? 'delayed' : 'queued';
}

function buildEnqueueSnapshot(
  def: TaskDefinition,
  data: QueueJobData,
  opts: JobsOptions,
  status: RunStatus,
): QueueRunSnapshot {
  const meta = data.__meta;
  const now = new Date();
  const delay = typeof opts.delay === 'number' ? opts.delay : undefined;

  return {
    id: data.__runId,
    transportJobId: typeof opts.jobId === 'string' ? opts.jobId : undefined,
    name: def.name,
    queue: def.queue,
    status,
    input: data.__input,
    meta,
    metadata: data.__metadata,
    tags: meta.tags ?? def.tags ?? [],
    scheduleId: stringMeta(meta.scheduleId),
    scheduleExternalId: stringMeta(meta.scheduleExternalId),
    attempt: 1,
    maxAttempts: opts.attempts ?? def.attempts,
    willRetry: false,
    parentRunId: stringMeta(meta.parentRunId),
    createdAt: now,
    queuedAt: now,
    delayedUntil:
      delay === undefined ? undefined : new Date(now.getTime() + delay),
    traceCarrier: data.__otel,
  };
}

function stringMeta(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function emitEnqueueHook(
  def: TaskDefinition,
  data: QueueJobData,
  opts: JobsOptions,
  status: RunStatus,
): Promise<void> {
  await sharedDrain.handle({
    type: 'enqueue',
    run: buildEnqueueSnapshot(def, data, opts, status),
  });
}

async function emitEnqueueFailureHook(
  def: TaskDefinition,
  data: QueueJobData,
  opts: JobsOptions,
  err: unknown,
): Promise<void> {
  await sharedDrain.handle({
    type: 'fail',
    run: {
      ...buildEnqueueSnapshot(def, data, opts, 'failed'),
      error: serializeError(err, { retryable: false }),
      finishedAt: new Date(),
      willRetry: false,
    },
  });
}

export async function enqueue<I, O>(
  def: TaskDefinition<I, O>,
  input: I,
  opts?: EnqueueOptions,
): Promise<EnqueueResult> {
  const parsedInput = def.schema ? def.schema.parse(input) : input;
  const queue = getQueue(def.queue);
  const runId = opts?.runId ?? opts?.jobId ?? randomUUID();
  const jobOpts = buildJobOptions(
    def as unknown as TaskDefinition<unknown, unknown>,
    runId,
    opts,
  );
  const data = buildJobData(parsedInput, runId, def.name, opts);
  await emitEnqueueHook(
    def as unknown as TaskDefinition,
    data,
    jobOpts,
    enqueueStatus(jobOpts),
  );
  let job: Awaited<ReturnType<Queue['add']>>;
  try {
    job = await queue.add(def.name, data, jobOpts);
  } catch (err) {
    await emitEnqueueFailureHook(
      def as unknown as TaskDefinition,
      data,
      jobOpts,
      err,
    );
    throw err;
  }
  const transportJobId = job.id ?? (jobOpts.jobId as string);
  return {
    id: runId,
    runId,
    jobId: transportJobId,
    transportJobId,
  };
}

interface BuiltFlowNode {
  def: FlowTaskDefinition;
  runId: string;
  flow: {
    name: string;
    queueName: string;
    data: QueueJobData;
    opts: JobsOptions;
    children?: BuiltFlowNode['flow'][];
  };
  children?: BuiltFlowNode[];
}

function withParentRunId(
  opts: EnqueueOptions | undefined,
  parentRunId: string | undefined,
): EnqueueOptions | undefined {
  if (!parentRunId) return opts;
  return {
    ...opts,
    meta: {
      ...opts?.meta,
      parentRunId: opts?.meta?.parentRunId ?? parentRunId,
    },
  };
}

function assertFlowJobId(jobId: string): void {
  if (jobId.includes(':')) {
    throw new Error('Flow job ids cannot contain ":"');
  }
}

function buildFlowNode(
  spec: FlowChildSpec,
  parentRunId?: string,
): BuiltFlowNode {
  const opts = withParentRunId(spec.opts, parentRunId);
  if (spec.def.schema) spec.def.schema.parse(spec.input);
  const runId = opts?.runId ?? opts?.jobId ?? randomUUID();
  const nodeOpts = buildJobOptions(spec.def, runId, opts);
  const transportJobId = nodeOpts.jobId as string;
  assertFlowJobId(transportJobId);

  const children = spec.children?.map((child) => buildFlowNode(child, runId));
  return {
    def: spec.def,
    runId,
    flow: {
      name: spec.def.name,
      queueName: spec.def.queue,
      data: buildJobData(spec.input, runId, spec.def.name, opts),
      opts: nodeOpts,
      children: children?.map((child) => child.flow),
    },
    children,
  };
}

function collectQueueNames(
  node: BuiltFlowNode,
  names = new Set<string>(),
): Set<string> {
  names.add(node.flow.queueName);
  for (const child of node.children ?? []) {
    collectQueueNames(child, names);
  }
  return names;
}

async function emitFlowEnqueueHooks(node: BuiltFlowNode): Promise<void> {
  await emitEnqueueHook(
    node.def as unknown as TaskDefinition,
    node.flow.data,
    node.flow.opts,
    enqueueStatus(node.flow.opts, Boolean(node.children?.length)),
  );

  const children = node.children ?? [];
  await Promise.all(children.map((child) => emitFlowEnqueueHooks(child)));
}

async function emitFlowEnqueueFailureHooks(
  node: BuiltFlowNode,
  err: unknown,
): Promise<void> {
  await emitEnqueueFailureHook(
    node.def as unknown as TaskDefinition,
    node.flow.data,
    node.flow.opts,
    err,
  );

  const children = node.children ?? [];
  await Promise.all(
    children.map((child) => emitFlowEnqueueFailureHooks(child, err)),
  );
}

function flowQueuesOptions(node: BuiltFlowNode) {
  return {
    queuesOptions: Object.fromEntries(
      Array.from(collectQueueNames(node)).map((queueName) => [
        queueName,
        { defaultJobOptions },
      ]),
    ),
  };
}

export async function enqueueFlow(
  parent: FlowParentSpec,
): Promise<EnqueueResult> {
  const node = buildFlowNode(parent);
  await emitFlowEnqueueHooks(node);
  let result: Awaited<ReturnType<FlowProducer['add']>>;
  try {
    result = await getFlowProducer().add(node.flow, flowQueuesOptions(node));
  } catch (err) {
    await emitFlowEnqueueFailureHooks(node, err);
    throw err;
  }
  const transportJobId = result.job.id ?? '';
  return {
    id: node.runId,
    runId: node.runId,
    jobId: transportJobId,
    transportJobId,
  };
}
