import type {
  BackoffOptions,
  EnqueueOptions,
  EnqueueResult,
  QueueDefinition,
  QueueSchedule,
  QueueScheduleListOptions,
  QueueSchedulesApi,
  Task,
  TaskDefinition,
  TaskDefinitionInput,
  TaskHandler,
} from './types';

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_BACKOFF: BackoffOptions = { type: 'exponential', delay: 1000 };

interface QueueRuntime {
  trigger<I, O>(
    target: string | TaskDefinition<I, O>,
    input: I,
    opts?: EnqueueOptions,
  ): Promise<EnqueueResult>;
  schedules?: QueueSchedulesApi;
}

const registered: TaskDefinition[] = [];
const taskSources = new WeakMap<object, string>();
let discoveryContext: string | undefined;
let runtime: QueueRuntime | null = null;

export function normalizeBackoff(
  backoff: BackoffOptions | number | undefined,
): BackoffOptions {
  if (backoff === undefined) return DEFAULT_BACKOFF;
  if (typeof backoff === 'number') return { type: 'fixed', delay: backoff };
  return backoff;
}

export function task<I, O>(input: TaskDefinitionInput<I, O>): Task<I, O> {
  const name = input.name ?? input.id;
  const targetQueue = resolveQueue(input.queue);
  const def: Task<I, O> = {
    id: input.id,
    name,
    queue: targetQueue.name ?? name,
    schema: input.schema,
    description: input.description,
    handler: resolveHandler(input),
    concurrency:
      input.concurrency ?? targetQueue.concurrency ?? DEFAULT_CONCURRENCY,
    attempts: input.attempts ?? DEFAULT_ATTEMPTS,
    backoff: normalizeBackoff(input.backoff),
    cron: input.cron,
    ttl: input.ttl,
    maxStalledCount: input.maxStalledCount,
    tags: input.tags ?? [],
    trigger: (payload, opts) => trigger(def, payload, opts),
    schedules: {
      create: (options) =>
        createTaskSchedule(def, options) as Promise<QueueSchedule>,
      list: (options) => listTaskSchedules(def, options),
      delete: (id) => deleteTaskSchedule(def, id),
    },
    child: (payload, opts, children) => ({
      def,
      input: payload,
      opts,
      children,
    }),
  };

  const taskDef = def as unknown as TaskDefinition;
  if (discoveryContext) taskSources.set(taskDef, discoveryContext);
  registered.push(taskDef);
  return def;
}

export function deriveDefaultInput<I>(
  schema: TaskDefinition<I, unknown>['schema'],
): { available: true; value: I } | { available: false } {
  if (!schema) return { available: true, value: {} as I };

  const objectResult = schema.safeParse({});
  if (objectResult.success) {
    return { available: true, value: objectResult.data };
  }

  const undefinedResult = schema.safeParse(undefined);
  if (undefinedResult.success) {
    return { available: true, value: undefinedResult.data };
  }

  return { available: false };
}

function resolveQueue(
  value: string | QueueDefinition | undefined,
): Partial<QueueDefinition> {
  if (!value) return {};
  return typeof value === 'string' ? { name: value } : value;
}

function resolveHandler<I, O>(
  input: TaskDefinitionInput<I, O>,
): TaskHandler<I, O> {
  if (input.run) return (ctx) => input.run!(ctx.input, ctx);
  throw new Error(`@openqueue/sdk: task "${input.id}" requires run`);
}

export function getRegisteredTasks(): TaskDefinition[] {
  return [...registered];
}

export function clearRegisteredTasks(): void {
  registered.length = 0;
}

export function setTaskDiscoveryContext(source: string): void {
  discoveryContext = source;
}

export function clearTaskDiscoveryContext(): void {
  discoveryContext = undefined;
}

export function validateTaskDefinitions(
  tasks: TaskDefinition[],
): TaskDefinition[] {
  const seen = new Map<string, TaskDefinition>();
  for (const def of tasks) {
    const existing = seen.get(def.id);
    if (existing) {
      const existingSource = taskSources.get(existing);
      const nextSource = taskSources.get(def);
      const sources =
        existingSource || nextSource
          ? ` in ${formatTaskSource(existingSource)} and ${formatTaskSource(nextSource)}`
          : '';
      throw new Error(
        `@openqueue/sdk: duplicate task id "${def.id}" for queues "${existing.queue}" and "${def.queue}"${sources}`,
      );
    }
    seen.set(def.id, def);
  }
  return tasks;
}

function formatTaskSource(source: string | undefined): string {
  return source ? JSON.stringify(source) : 'an unknown file';
}

export function bindQueueRuntime(next: QueueRuntime): void {
  runtime = next;
}

export function unbindQueueRuntime(): void {
  runtime = null;
}

export async function trigger<I, O>(
  target: string | TaskDefinition<I, O>,
  input: I,
  opts?: EnqueueOptions,
): Promise<EnqueueResult> {
  if (!runtime) {
    const id = typeof target === 'string' ? target : target.id;
    throw new Error(
      `@openqueue/sdk: task "${id}" cannot be triggered before a queue runtime is created`,
    );
  }
  return runtime.trigger(target as TaskDefinition<I, O>, input, opts);
}

async function createTaskSchedule<I, O>(
  target: TaskDefinition<I, O>,
  options: Parameters<Task['schedules']['create']>[0],
): Promise<QueueSchedule> {
  if (!runtime?.schedules) {
    throw new Error(
      `@openqueue/sdk: task "${target.id}" cannot create schedules before a queue runtime with storage is created`,
    );
  }
  return runtime.schedules.create({
    ...options,
    task: target as TaskDefinition,
  });
}

async function listTaskSchedules<I, O>(
  target: TaskDefinition<I, O>,
  options?: Omit<QueueScheduleListOptions, 'task'>,
): Promise<QueueSchedule[]> {
  if (!runtime?.schedules) {
    throw new Error(
      `@openqueue/sdk: task "${target.id}" cannot list schedules before a queue runtime with storage is created`,
    );
  }
  return runtime.schedules.list({
    ...options,
    task: target.id,
  });
}

async function deleteTaskSchedule<I, O>(
  target: TaskDefinition<I, O>,
  id: string,
): Promise<boolean> {
  if (!runtime?.schedules) {
    throw new Error(
      `@openqueue/sdk: task "${target.id}" cannot delete schedules before a queue runtime with storage is created`,
    );
  }
  const schedule = await runtime.schedules.retrieve(id);
  if (schedule.task !== target.id) {
    throw new Error(
      `@openqueue/sdk: task "${target.id}" cannot delete schedule "${id}" for task "${schedule.task}"`,
    );
  }
  return runtime.schedules.delete(id);
}
