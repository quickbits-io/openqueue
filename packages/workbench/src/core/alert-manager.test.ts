import type { Queue } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { AlertManager } from './alert-manager';
import { MemoryAlertStore } from './alert-store';
import type { QueueManager } from './queue-manager';
import type { AlertRule } from './types';

/**
 * The cooldown map is private state the fire path maintains; it isn't part of
 * the public surface, so this regression guard inspects it directly. `fireRule`
 * is the internal entry point a QueueEvents 'failed' handler reaches.
 */
interface CooldownView {
  fireRule(
    rule: AlertRule,
    ctx: { queue?: string; jobId?: string; failedReason?: string },
  ): Promise<void>;
  cooldowns: Map<string, unknown>;
}

const CAP = 10_000;

function makeManager(cooldownMs: number): CooldownView {
  const manager = new AlertManager(
    {} as unknown as QueueManager,
    () => new Map<string, Queue>(),
    { enabled: true, defaults: { cooldownMs } },
    new MemoryAlertStore(),
  );
  return manager as unknown as CooldownView;
}

const failedRule: AlertRule = {
  id: 'rule-1',
  name: 'failed jobs',
  enabled: true,
  trigger: 'job_failed',
  severity: 'warning',
  queues: ['q'],
  contactPointIds: [],
  createdAt: 0,
  updatedAt: 0,
};

describe('AlertManager store ownership on close', () => {
  class ClosableStore extends MemoryAlertStore {
    closed = false;
    async close(): Promise<void> {
      this.closed = true;
    }
  }

  function manager(store: ClosableStore, ownsStore: boolean): AlertManager {
    return new AlertManager(
      {} as unknown as QueueManager,
      () => new Map<string, Queue>(),
      { enabled: true },
      store,
      'custom',
      ownsStore,
    );
  }

  it('leaves an injected (world-owned) alert store open', async () => {
    // The runtime owns and closes this store during drain; the workbench must
    // not close it here (early/double-close of a shared DB/Redis client).
    const store = new ClosableStore();
    await manager(store, false).close();
    expect(store.closed).toBe(false);
  });

  it('closes a store it owns (e.g. a self-created Redis store)', async () => {
    // The standalone workbench builds its own Redis store via createAlertStore
    // and must close it on WorkbenchCore.close() to avoid an ioredis leak.
    const store = new ClosableStore();
    await manager(store, true).close();
    expect(store.closed).toBe(true);
  });
});

describe('AlertManager cooldown retention', () => {
  it('stays bounded when many distinct jobs fire a per-job rule', async () => {
    // A long cooldown means no entry expires during the run, so the cap must be
    // held by evicting oldest entries — the unbounded-growth regression guard.
    const view = makeManager(60_000);
    for (let i = 0; i < CAP + 5_000; i++) {
      await view.fireRule(failedRule, {
        queue: 'q',
        jobId: `job-${i}`,
        failedReason: 'boom',
      });
    }
    expect(view.cooldowns.size).toBeLessThanOrEqual(CAP);
  });

  it('reclaims entries whose cooldown window has elapsed', async () => {
    // Zero cooldown → every prior fingerprint is already expired by the time the
    // map overflows, so the sweep reclaims them all rather than the map ceiling.
    const view = makeManager(0);
    for (let i = 0; i < CAP + 100; i++) {
      await view.fireRule(failedRule, {
        queue: 'q',
        jobId: `job-${i}`,
        failedReason: 'boom',
      });
    }
    expect(view.cooldowns.size).toBeLessThanOrEqual(CAP);
  });
});
