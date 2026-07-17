import type { BackoffOptions } from '../types';

/**
 * A transport's declared feature set. Core enforces each flag before it reaches
 * for the matching transport method, so an unsupported call fails with a typed
 * {@link UnsupportedCapabilityError} instead of silently degrading.
 */
export interface TransportCapabilities {
  delay: boolean;
  priority: boolean;
  flows: boolean;
  deduplication: boolean;
  remove: boolean;
}

export type TransportCapability = keyof TransportCapabilities;

export class UnsupportedCapabilityError extends Error {
  readonly capability: TransportCapability;

  constructor(capability: TransportCapability, transportId: string) {
    super(
      `@openqueue/sdk: transport "${transportId}" does not support "${capability}"`,
    );
    this.name = 'UnsupportedCapabilityError';
    this.capability = capability;
  }
}

export function assertCapability(
  transport: Pick<QueueTransport, 'id' | 'capabilities'>,
  capability: TransportCapability,
): void {
  if (!transport.capabilities[capability]) {
    throw new UnsupportedCapabilityError(capability, transport.id);
  }
}

/** How long a delivered job survives after completing or exhausting attempts. */
export interface TransportRetention {
  removeOnComplete?: boolean | number | { age: number; count?: number };
  removeOnFail?: boolean | number | { age: number; count?: number };
}

export interface TransportJobSpec {
  /** Stable delivery id; doubles as the deduplication key. */
  id: string;
  name: string;
  data: unknown;
  delay?: number;
  priority?: number;
  attempts?: number;
  backoff?: BackoffOptions | number;
  retention?: TransportRetention;
  failParentOnFailure?: boolean;
  continueParentOnFailure?: boolean;
  ignoreDependencyOnFailure?: boolean;
}

export interface TransportFlowNode {
  queue: string;
  spec: TransportJobSpec;
  children?: TransportFlowNode[];
}

/**
 * A retrieved (not-yet-active) job. Shaped to satisfy cancel's `CancelableJob`
 * and the scheduler's delayed-tick reconciliation without either importing the
 * transport.
 */
export interface TransportJobHandle {
  name: string;
  data: unknown;
  attemptsMade: number;
  opts: { attempts?: number };
  remove(): Promise<void>;
}

/** A job handed to a consumer's processor and lifecycle callbacks. */
export interface ActiveTransportJob {
  id?: string;
  name: string;
  queueName: string;
  data: unknown;
  timestamp: number;
  attemptsMade: number;
  processedOn?: number;
  finishedOn?: number;
  returnvalue: unknown;
  opts: { attempts?: number; delay?: number };
  updateData(data: unknown): Promise<void>;
  updateProgress(progress: unknown): Promise<void>;
  log(line: string): Promise<unknown>;
}

export interface ConsumeOptions {
  concurrency?: number;
  maxStalledCount?: number;
  process(job: ActiveTransportJob): Promise<unknown>;
  /** Core passes `isNonRetryable`; a `true` result stops retries this attempt. */
  isFinal(err: unknown): boolean;
  onCompleted(job: ActiveTransportJob): Promise<void> | void;
  /** Fires on every attempt; `final` distinguishes the last from a retry. */
  onFailed(
    job: ActiveTransportJob | undefined,
    err: unknown,
    outcome: { final: boolean },
  ): Promise<void> | void;
  onError(err: unknown): void;
}

export interface TransportConsumer {
  close(): Promise<void>;
}

/**
 * The delivery bus behind a world: enqueue, retrieve, and consume jobs. Durable
 * run/schedule/catalog state lives in the paired `QueueStorage`, not here.
 */
export interface QueueTransport {
  readonly id: string;
  readonly capabilities: TransportCapabilities;
  enqueue(queue: string, spec: TransportJobSpec): Promise<{ jobId: string }>;
  enqueueFlow(node: TransportFlowNode): Promise<{ jobId: string }>;
  getJob(queue: string, id: string): Promise<TransportJobHandle | undefined>;
  listDelayed(queue: string): Promise<TransportJobHandle[]>;
  consume(queue: string, options: ConsumeOptions): TransportConsumer;
  close(): Promise<void>;
}
