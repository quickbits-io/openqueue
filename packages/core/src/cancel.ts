import { isTerminalRunStatus } from './runs';
import { assertCapability, type QueueTransport } from './transport/types';
import type {
  CancelRunResult,
  QueueDrain,
  QueueRunSnapshot,
  QueueRunStore,
} from './types';

interface CancelableJob {
  attemptsMade: number;
  opts: { attempts?: number };
  remove(): Promise<void>;
}

interface CancelableQueue {
  getJob(id: string): Promise<CancelableJob | undefined>;
}

interface CancelRunDeps {
  store: QueueRunStore;
  transport: Pick<QueueTransport, 'id' | 'capabilities'>;
  getQueue(name: string): CancelableQueue;
  drain: QueueDrain;
}

export function createRunCancel(
  deps: CancelRunDeps,
): (id: string) => Promise<CancelRunResult> {
  return async (id) => {
    const { data } = await deps.store.list({ id, limit: 1 });
    const run = data[0];
    if (!run) return { outcome: 'not_found' };
    if (isTerminalRunStatus(run.status)) {
      return { outcome: 'already_finished', run };
    }
    if (run.status === 'executing') {
      return { outcome: 'not_cancelable', run, reason: 'executing' };
    }

    // Outside the try/catch below: an unsupported transport must surface an
    // UnsupportedCapabilityError, not be mapped to `not_cancelable`.
    assertCapability(deps.transport, 'remove');

    const job = await deps
      .getQueue(run.queue)
      .getJob(run.transportJobId ?? run.id);
    if (job) {
      try {
        await job.remove();
      } catch {
        return { outcome: 'not_cancelable', run, reason: 'executing' };
      }
    }

    const finishedAt = new Date();
    const snapshot: QueueRunSnapshot = {
      id: run.id,
      transportJobId: run.transportJobId,
      name: run.task,
      queue: run.queue,
      status: 'canceled',
      input: run.input,
      output: run.output,
      error: run.error,
      meta: run.meta,
      metadata: run.metadata,
      tags: run.tags,
      scheduleId: run.scheduleId,
      scheduleExternalId: run.scheduleExternalId,
      attempt: (job?.attemptsMade ?? 0) + 1,
      maxAttempts: job?.opts.attempts ?? 1,
      willRetry: false,
      parentRunId: run.meta.parentRunId,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt,
    };
    await deps.drain.handle({ type: 'cancel', run: snapshot });

    return {
      outcome: 'canceled',
      run: { ...run, status: 'canceled', finishedAt, updatedAt: finishedAt },
    };
  };
}
