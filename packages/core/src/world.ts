import type { ResolvedNamespace } from './namespace';
import type { QueueTransport } from './transport/types';
import type { QueueStorage } from './types';

export type {
  ActiveTransportJob,
  ConsumeOptions,
  QueueTransport,
  TransportCapabilities,
  TransportCapability,
  TransportConsumer,
  TransportFlowNode,
  TransportJobHandle,
  TransportJobSpec,
  TransportRetention,
} from './transport/types';
export { UnsupportedCapabilityError } from './transport/types';

/**
 * The contract Phase 3 composes behind: a world pairs one
 * {@link QueueTransport} (delivery) with one {@link QueueStorage} (durable
 * state) under a single ownership boundary. This module is import-clean —
 * it pulls in no ioredis/bullmq — so `@openqueue/core/world` can be consumed
 * by third-party transports (e.g. `@openqueue/world-postgres`) without dragging
 * the Redis stack into their bundle.
 */
export const WORLD_SPEC_VERSION = 1;

export interface WorldContext {
  namespace: ResolvedNamespace;
}

export type WorldFactory = (
  ctx: WorldContext,
) => OpenQueueWorld | Promise<OpenQueueWorld>;

/** One committed migration step: its stable id, content checksum, and SQL. */
export interface WorldMigrationStep {
  id: string;
  checksum: string;
  sql: string;
}

export type WorldMigrationState = 'applied' | 'pending' | 'checksum_mismatch';

export interface WorldMigrationStatus {
  id: string;
  state: WorldMigrationState;
  appliedAt?: Date;
}

/**
 * A world's embedded schema migrations: the committed steps plus a read-only
 * status probe. Present only on worlds that own durable SQL state.
 */
export interface WorldMigrations {
  steps: readonly WorldMigrationStep[];
  status(): Promise<WorldMigrationStatus[]>;
}

export interface OpenQueueWorld {
  specVersion: number;
  transport: QueueTransport;
  store: QueueStorage;
  migrations?: WorldMigrations;
  start?(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Reject a world built against an incompatible core, then shallow-check that
 * its transport and store carry the methods the runtime wires. Returns the same
 * world so callers can validate inline.
 */
export function validateWorld(world: OpenQueueWorld): OpenQueueWorld {
  if (world.specVersion !== WORLD_SPEC_VERSION) {
    throw new Error(
      `@openqueue/sdk: world specVersion ${world.specVersion} is incompatible with this core (expected ${WORLD_SPEC_VERSION}). Upgrade the @openqueue/* packages in lockstep.`,
    );
  }

  const transport = world.transport;
  if (
    !transport ||
    typeof transport.id !== 'string' ||
    !transport.capabilities ||
    typeof transport.enqueue !== 'function' ||
    typeof transport.enqueueFlow !== 'function' ||
    typeof transport.getJob !== 'function' ||
    typeof transport.listDelayed !== 'function' ||
    typeof transport.consume !== 'function' ||
    typeof transport.close !== 'function'
  ) {
    throw new Error(
      '@openqueue/sdk: world.transport is not a valid QueueTransport',
    );
  }

  const store = world.store;
  if (
    !store ||
    typeof store.handle !== 'function' ||
    typeof store.publish !== 'function' ||
    typeof store.resolve !== 'function' ||
    typeof store.read !== 'function' ||
    !store.schedules ||
    !store.runs ||
    !store.alerts
  ) {
    throw new Error('@openqueue/sdk: world.store is not a valid QueueStorage');
  }

  return world;
}
