import { randomUUID } from 'node:crypto';
import { composeDrains } from './compose';
import { serializeError } from './errors';
import { captureTraceCarrier, startRunSpan } from './otel-hooks';
import {
  assertCapability,
  type QueueTransport,
  type TransportFlowNode,
  type TransportJobSpec,
} from './transport/types';
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

export interface EnqueuerOptions {
  transport: QueueTransport;
  /** Already-composed sink; defaults to a no-op composed drain. */
  drain?: QueueDrain;
}

/**
 * Instance-scoped enqueue engine bound to one transport + drain. The
 * module-global facade (`enqueue.ts`) delegates to a default instance; each
 * runtime gets its own so multi-runtime processes keep isolated drains.
 *
 * Import-clean on purpose (node:crypto + pure core modules only): no
 * ioredis/bullmq, so it rides into the `@openqueue/core/control` bundle graph.
 */
export interface Enqueuer {
  enqueue<I, O>(
    def: TaskDefinition<I, O>,
    input: I,
    opts?: EnqueueOptions,
  ): Promise<EnqueueResult>;
  enqueueFlow(parent: FlowParentSpec): Promise<EnqueueResult>;
}

/** The snapshot/hook fields read off a task definition — enough for both a full
 * {@link TaskDefinition} and a {@link FlowTaskDefinition}. */
type EnqueueSnapshotDef = Pick<
  TaskDefinition,
  'name' | 'queue' | 'attempts' | 'tags'
>;

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

function buildJobSpec(
  def: Pick<
    TaskDefinition<unknown, unknown>,
    'name' | 'attempts' | 'backoff' | 'ttl'
  >,
  runId: string,
  data: QueueJobData,
  opts?: EnqueueOptions,
): TransportJobSpec {
  return {
    id: opts?.jobId ?? runId,
    name: def.name,
    data,
    delay: opts?.delay,
    priority: opts?.priority,
    attempts: opts?.attempts ?? def.attempts,
    backoff: opts?.backoff ?? def.backoff,
    ttl: opts?.ttl ?? def.ttl,
    failParentOnFailure: opts?.failParentOnFailure,
    continueParentOnFailure: opts?.continueParentOnFailure,
    ignoreDependencyOnFailure: opts?.ignoreDependencyOnFailure,
  };
}

function enqueueStatus(spec: TransportJobSpec, hasChildren = false): RunStatus {
  if (hasChildren) return 'waiting_children';
  return spec.delay ? 'delayed' : 'queued';
}

function buildEnqueueSnapshot(
  def: EnqueueSnapshotDef,
  data: QueueJobData,
  spec: TransportJobSpec,
  status: RunStatus,
): QueueRunSnapshot {
  const meta = data.__meta;
  const now = new Date();
  const delay = spec.delay;

  return {
    id: data.__runId,
    transportJobId: spec.id,
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
    maxAttempts: spec.attempts ?? def.attempts,
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

interface BuiltFlowNode {
  def: FlowTaskDefinition;
  runId: string;
  queue: string;
  data: QueueJobData;
  spec: TransportJobSpec;
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
  child: FlowChildSpec,
  parentRunId?: string,
): BuiltFlowNode {
  const opts = withParentRunId(child.opts, parentRunId);
  if (child.def.schema) child.def.schema.parse(child.input);
  const runId = opts?.runId ?? opts?.jobId ?? randomUUID();
  const data = buildJobData(child.input, runId, child.def.name, opts);
  const spec = buildJobSpec(child.def, runId, data, opts);
  assertFlowJobId(spec.id);

  const children = child.children?.map((node) => buildFlowNode(node, runId));
  return {
    def: child.def,
    runId,
    queue: child.def.queue,
    data,
    spec,
    children,
  };
}

function toTransportFlowNode(node: BuiltFlowNode): TransportFlowNode {
  return {
    queue: node.queue,
    spec: node.spec,
    children: node.children?.map(toTransportFlowNode),
  };
}

export function createEnqueuer(options: EnqueuerOptions): Enqueuer {
  const { transport } = options;
  const drain = options.drain ?? composeDrains();

  async function emitEnqueueHook(
    def: EnqueueSnapshotDef,
    data: QueueJobData,
    spec: TransportJobSpec,
    status: RunStatus,
  ): Promise<void> {
    await drain.handle({
      type: 'enqueue',
      run: buildEnqueueSnapshot(def, data, spec, status),
    });
  }

  async function emitEnqueueFailureHook(
    def: EnqueueSnapshotDef,
    data: QueueJobData,
    spec: TransportJobSpec,
    err: unknown,
  ): Promise<void> {
    await drain.handle({
      type: 'fail',
      run: {
        ...buildEnqueueSnapshot(def, data, spec, 'failed'),
        error: serializeError(err, { retryable: false }),
        finishedAt: new Date(),
        willRetry: false,
      },
    });
  }

  async function emitFlowEnqueueHooks(node: BuiltFlowNode): Promise<void> {
    await emitEnqueueHook(
      node.def,
      node.data,
      node.spec,
      enqueueStatus(node.spec, Boolean(node.children?.length)),
    );

    const children = node.children ?? [];
    await Promise.all(children.map((child) => emitFlowEnqueueHooks(child)));
  }

  async function emitFlowEnqueueFailureHooks(
    node: BuiltFlowNode,
    err: unknown,
  ): Promise<void> {
    await emitEnqueueFailureHook(node.def, node.data, node.spec, err);

    const children = node.children ?? [];
    await Promise.all(
      children.map((child) => emitFlowEnqueueFailureHooks(child, err)),
    );
  }

  async function enqueue<I, O>(
    def: TaskDefinition<I, O>,
    input: I,
    opts?: EnqueueOptions,
  ): Promise<EnqueueResult> {
    const parsedInput = def.schema ? def.schema.parse(input) : input;
    const runId = opts?.runId ?? opts?.jobId ?? randomUUID();
    const data = buildJobData(parsedInput, runId, def.name, opts);
    const spec = buildJobSpec(def, runId, data, opts);

    if (spec.delay !== undefined) assertCapability(transport, 'delay');
    if (spec.priority !== undefined) assertCapability(transport, 'priority');

    await emitEnqueueHook(def, data, spec, enqueueStatus(spec));

    let result: { jobId: string };
    try {
      result = await transport.enqueue(def.queue, spec);
    } catch (err) {
      await emitEnqueueFailureHook(def, data, spec, err);
      throw err;
    }

    return {
      id: runId,
      runId,
      jobId: result.jobId,
      transportJobId: result.jobId,
    };
  }

  async function enqueueFlow(parent: FlowParentSpec): Promise<EnqueueResult> {
    const node = buildFlowNode(parent);
    assertCapability(transport, 'flows');
    await emitFlowEnqueueHooks(node);

    let result: { jobId: string };
    try {
      result = await transport.enqueueFlow(toTransportFlowNode(node));
    } catch (err) {
      await emitFlowEnqueueFailureHooks(node, err);
      throw err;
    }

    return {
      id: node.runId,
      runId: node.runId,
      jobId: result.jobId,
      transportJobId: result.jobId,
    };
  }

  return { enqueue, enqueueFlow };
}
