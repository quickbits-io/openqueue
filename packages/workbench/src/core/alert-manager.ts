import { type Queue, QueueEvents } from 'bullmq';
import { deliverToContactPoint } from './alert-destinations';
import { type AlertStore, createAlertStore } from './alert-store';
import type { QueueManager } from './queue-manager';
import type {
  AlertDeliveryRecord,
  AlertEvent,
  AlertPersistence,
  AlertRule,
  AlertRuntimeStatus,
  AlertsOptions,
  AlertTrigger,
} from './types';

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const MAX_RECENT_EVENTS = 100;
const MAX_DELIVERY_RECORDS = 50;
// Per-job triggers (job_failed/stalled/retries_exhausted) fingerprint by jobId,
// so the cooldown map would otherwise grow one entry per failed job forever.
// Cap it and evict expired/oldest entries — an elapsed cooldown can no longer
// suppress anything, so dropping it is behaviour-preserving.
const MAX_COOLDOWN_ENTRIES = 10_000;

interface CooldownEntry {
  lastFiredAt: number;
  expiresAt: number;
}

export class AlertManager {
  private readonly store: AlertStore;
  /**
   * True only when this manager created its own store (e.g. a Redis store it
   * owns). An injected store is world-owned — the runtime closes it during
   * drain, so closing it here would tear a shared client down early or twice.
   */
  private readonly ownsStore: boolean;
  private readonly persistence: AlertPersistence;
  private readonly options: AlertsOptions;
  private readonly queueManager: QueueManager;
  private readonly getQueues: () => Map<string, Queue>;

  private queueEvents: QueueEvents[] = [];
  private listenerStatus = new Map<string, boolean>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private lastHealthCheckAt?: number;
  private recentEvents: AlertEvent[] = [];
  private lastDeliveries: AlertDeliveryRecord[] = [];
  private cooldowns = new Map<string, CooldownEntry>();
  private activeHealthAlerts = new Map<string, AlertEvent>();
  private started = false;
  private closed = false;

  constructor(
    queueManager: QueueManager,
    getQueues: () => Map<string, Queue>,
    options: AlertsOptions,
    store?: AlertStore,
    persistence: AlertPersistence = 'memory',
    ownsStore?: boolean,
  ) {
    this.queueManager = queueManager;
    this.getQueues = getQueues;
    this.options = options;
    this.store = store ?? createAlertStore(options, {}).store;
    // Ownership is decided by the caller: a store AlertManager built itself is
    // owned, and for an injected store the caller declares it (WorkbenchCore
    // owns one it created via createAlertStore, but not a world-owned store
    // handed in as `alerts.store`). Default: own only a self-created store.
    this.ownsStore = ownsStore ?? store === undefined;
    this.persistence = persistence;
  }

  get enabled(): boolean {
    return this.options.enabled !== false;
  }

  getStore(): AlertStore {
    return this.store;
  }

  /** Start QueueEvents listeners and health-check loop */
  async start(): Promise<void> {
    if (this.options.enabled === false || this.started || this.closed) return;
    this.started = true;

    const queues = this.getQueues();
    for (const [name, queue] of queues) {
      const connection = queue.opts?.connection;
      if (!connection) {
        this.listenerStatus.set(name, false);
        continue;
      }

      try {
        const qe = new QueueEvents(name, { connection });
        this.queueEvents.push(qe);
        this.listenerStatus.set(name, true);

        qe.on('failed', ({ jobId, failedReason }) => {
          void this.handleQueueEvent(name, 'job_failed', {
            jobId,
            failedReason,
          });
        });

        qe.on('stalled', ({ jobId }) => {
          void this.handleQueueEvent(name, 'job_stalled', { jobId });
        });

        qe.on('retries-exhausted', ({ jobId, attemptsMade }) => {
          void this.handleQueueEvent(name, 'retries_exhausted', {
            jobId,
            attemptsMade: Number(attemptsMade),
          });
        });

        qe.on('error', () => {
          this.listenerStatus.set(name, false);
        });
      } catch {
        this.listenerStatus.set(name, false);
      }
    }

    this.healthTimer = setInterval(() => {
      void this.runHealthChecks();
    }, HEALTH_CHECK_INTERVAL_MS);
    void this.runHealthChecks();
  }

  async close(): Promise<void> {
    if (this.ownsStore) await this.store.close?.();
    await this.closeListeners();
  }

  private async closeListeners(): Promise<void> {
    this.closed = true;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    await Promise.all(
      this.queueEvents.map(async (qe) => {
        try {
          await qe.close();
        } catch {
          // ignore close errors
        }
      }),
    );
    this.queueEvents = [];
  }

  async getStatus(): Promise<AlertRuntimeStatus> {
    const listeners = Array.from(this.listenerStatus.entries()).map(
      ([queue, connected]) => ({ queue, connected }),
    );
    return {
      enabled: this.options.enabled !== false,
      persistence: this.persistence,
      listenerCount: listeners.length,
      listeners,
      healthCheckIntervalMs: HEALTH_CHECK_INTERVAL_MS,
      lastHealthCheckAt: this.lastHealthCheckAt,
      recentEvents: [...this.recentEvents],
      lastDeliveries: [...this.lastDeliveries],
      defaults: {
        cooldownMs: this.options.defaults?.cooldownMs ?? 5 * 60 * 1000,
        sendResolved: this.options.defaults?.sendResolved ?? true,
      },
    };
  }

  /** Send a test notification through a contact point */
  async sendTest(contactPointId: string): Promise<AlertDeliveryRecord> {
    const cp = await this.store.getContactPoint(contactPointId);
    if (!cp) {
      return {
        contactPointId,
        contactPointName: 'Unknown',
        success: false,
        error: 'Contact point not found',
        at: Date.now(),
      };
    }

    const testEvent: AlertEvent = {
      id: crypto.randomUUID(),
      ruleId: 'test',
      ruleName: 'Test notification',
      trigger: 'job_failed',
      severity: 'info',
      status: 'firing',
      fingerprint: 'test',
      queue: 'example',
      jobId: 'test-job',
      jobName: 'exampleJob',
      message: 'This is a test alert from Workbench.',
      firedAt: Date.now(),
    };

    const result = await deliverToContactPoint(
      cp,
      testEvent,
      this.options.dashboardUrl,
    );
    const record: AlertDeliveryRecord = {
      contactPointId: cp.id,
      contactPointName: cp.name,
      success: result.success,
      error: result.error,
      at: Date.now(),
    };
    this.pushDelivery(record);
    return record;
  }

  /** Preview what a rule would look like without sending */
  previewRule(rule: AlertRule): AlertEvent {
    return {
      id: crypto.randomUUID(),
      ruleId: rule.id,
      ruleName: rule.name,
      trigger: rule.trigger,
      severity: rule.severity,
      status: 'firing',
      fingerprint: `preview:${rule.id}`,
      queue: rule.queues?.[0] ?? 'my-queue',
      jobId: '12345',
      jobName: 'exampleJob',
      message: this.buildMessage(rule, {
        queue: rule.queues?.[0] ?? 'my-queue',
        jobName: 'exampleJob',
        failedReason: 'Example failure reason',
      }),
      failedReason: 'Example failure reason',
      firedAt: Date.now(),
    };
  }

  private async handleQueueEvent(
    queueName: string,
    trigger: AlertTrigger,
    ctx: { jobId: string; failedReason?: string; attemptsMade?: number },
  ): Promise<void> {
    const rules = await this.store.getRules();
    const matching = rules.filter(
      (r) =>
        r.enabled && r.trigger === trigger && this.matchesQueue(r, queueName),
    );
    if (matching.length === 0) return;

    let jobName: string | undefined;
    if (ctx.jobId) {
      const job = await this.queueManager.getJob(queueName, ctx.jobId);
      jobName = job?.name;
      if (jobName && matching.every((r) => !this.matchesJobName(r, jobName!))) {
        return;
      }
    }

    for (const rule of matching) {
      if (jobName && !this.matchesJobName(rule, jobName)) continue;
      await this.fireRule(rule, {
        queue: queueName,
        jobId: ctx.jobId,
        jobName,
        failedReason: ctx.failedReason,
        attemptsMade: ctx.attemptsMade,
      });
    }
  }

  private async runHealthChecks(): Promise<void> {
    if (this.options.enabled === false || this.closed) return;
    this.lastHealthCheckAt = Date.now();

    const rules = await this.store.getRules();
    const healthRules = rules.filter(
      (r) =>
        r.enabled &&
        (r.trigger === 'failed_backlog' ||
          r.trigger === 'no_workers_with_backlog'),
    );
    if (healthRules.length === 0) return;

    let queuesInfo: Awaited<ReturnType<QueueManager['getQueues']>>;
    try {
      queuesInfo = await this.queueManager.getQueues();
    } catch {
      return;
    }

    for (const rule of healthRules) {
      for (const queue of queuesInfo) {
        if (!this.matchesQueue(rule, queue.name)) continue;

        const backlog =
          queue.counts.waiting +
          queue.counts.prioritized +
          queue.counts['waiting-children'];

        let firing = false;
        let message = '';
        const counts: AlertEvent['counts'] = {
          failed: queue.counts.failed,
          backlog,
          workers: queue.workerCount,
        };

        if (rule.trigger === 'failed_backlog') {
          const threshold = rule.threshold ?? 1;
          if (queue.counts.failed >= threshold) {
            firing = true;
            message = `${queue.counts.failed} failed jobs in ${queue.name} (threshold: ${threshold})`;
          }
        } else if (rule.trigger === 'no_workers_with_backlog') {
          if (
            queue.workerCount === 0 &&
            backlog > 0 &&
            queue.workerCount !== null &&
            queue.workerCount !== undefined
          ) {
            firing = true;
            message = `${backlog} jobs waiting in ${queue.name} with no workers connected`;
          }
        }

        const fp = `${rule.id}:${queue.name}:${rule.trigger}`;
        const existing = this.activeHealthAlerts.get(fp);

        if (firing) {
          if (!existing) {
            await this.fireRule(rule, { queue: queue.name, counts, message });
            // fireRule stores in recentEvents; track active for resolve
            const last = this.recentEvents[0];
            if (last?.fingerprint === fp) {
              this.activeHealthAlerts.set(fp, last);
            }
          }
        } else if (existing && this.options.defaults?.sendResolved !== false) {
          await this.resolveHealthAlert(existing, rule);
          this.activeHealthAlerts.delete(fp);
        } else if (existing) {
          this.activeHealthAlerts.delete(fp);
        }
      }
    }
  }

  private async resolveHealthAlert(
    event: AlertEvent,
    rule: AlertRule,
  ): Promise<void> {
    const resolved: AlertEvent = {
      ...event,
      id: crypto.randomUUID(),
      status: 'resolved',
      message: `Resolved: ${event.message}`,
      resolvedAt: Date.now(),
    };
    this.pushEvent(resolved);
    await this.deliver(resolved, rule);
  }

  private async fireRule(
    rule: AlertRule,
    ctx: {
      queue?: string;
      jobId?: string;
      jobName?: string;
      failedReason?: string;
      attemptsMade?: number;
      counts?: AlertEvent['counts'];
      message?: string;
    },
  ): Promise<void> {
    const fingerprint = this.buildFingerprint(rule, ctx);
    const cooldownMs =
      rule.cooldownMs ?? this.options.defaults?.cooldownMs ?? 5 * 60 * 1000;
    const now = Date.now();
    const prev = this.cooldowns.get(fingerprint);
    if (prev && now - prev.lastFiredAt < cooldownMs) {
      return;
    }

    const event: AlertEvent = {
      id: crypto.randomUUID(),
      ruleId: rule.id,
      ruleName: rule.name,
      trigger: rule.trigger,
      severity: rule.severity,
      status: 'firing',
      fingerprint,
      queue: ctx.queue,
      jobId: ctx.jobId,
      jobName: ctx.jobName,
      message: ctx.message ?? this.buildMessage(rule, ctx),
      failedReason: ctx.failedReason,
      attemptsMade: ctx.attemptsMade,
      counts: ctx.counts,
      firedAt: now,
    };

    this.cooldowns.set(fingerprint, {
      lastFiredAt: now,
      expiresAt: now + cooldownMs,
    });
    this.pruneCooldowns(now);
    this.pushEvent(event);
    await this.deliver(event, rule);
  }

  /**
   * Keep {@link cooldowns} bounded. Only sweeps once the map exceeds the cap, so
   * the common path stays O(1); on overflow it drops expired windows first, then
   * the oldest entries (Map preserves insertion order) to hold the ceiling.
   */
  private pruneCooldowns(now: number): void {
    if (this.cooldowns.size <= MAX_COOLDOWN_ENTRIES) return;
    for (const [fingerprint, entry] of this.cooldowns) {
      if (entry.expiresAt <= now) this.cooldowns.delete(fingerprint);
    }
    if (this.cooldowns.size <= MAX_COOLDOWN_ENTRIES) return;
    const excess = this.cooldowns.size - MAX_COOLDOWN_ENTRIES;
    let removed = 0;
    for (const fingerprint of this.cooldowns.keys()) {
      if (removed >= excess) break;
      this.cooldowns.delete(fingerprint);
      removed += 1;
    }
  }

  private async deliver(event: AlertEvent, rule: AlertRule): Promise<void> {
    const allCps = await this.store.getContactPoints();
    const cps = allCps.filter(
      (cp) => cp.enabled && rule.contactPointIds.includes(cp.id),
    );

    await Promise.all(
      cps.map(async (cp) => {
        const result = await deliverToContactPoint(
          cp,
          event,
          this.options.dashboardUrl,
        );
        this.pushDelivery({
          contactPointId: cp.id,
          contactPointName: cp.name,
          success: result.success,
          error: result.error,
          at: Date.now(),
        });
      }),
    );
  }

  private buildFingerprint(
    rule: AlertRule,
    ctx: {
      queue?: string;
      jobId?: string;
    },
  ): string {
    const parts = [rule.id, rule.trigger, ctx.queue ?? 'all'];
    if (
      rule.trigger === 'job_failed' ||
      rule.trigger === 'job_stalled' ||
      rule.trigger === 'retries_exhausted'
    ) {
      parts.push(ctx.jobId ?? 'unknown');
    }
    return parts.join(':');
  }

  private buildMessage(
    rule: AlertRule,
    ctx: {
      queue?: string;
      jobId?: string;
      jobName?: string;
      failedReason?: string;
      attemptsMade?: number;
    },
  ): string {
    switch (rule.trigger) {
      case 'job_failed':
        return `Job ${ctx.jobName ?? 'unknown'} failed in ${ctx.queue ?? 'queue'}${ctx.failedReason ? `: ${ctx.failedReason.slice(0, 200)}` : ''}`;
      case 'job_stalled':
        return `Job ${ctx.jobName ?? ctx.jobId ?? 'unknown'} stalled in ${ctx.queue ?? 'queue'}`;
      case 'retries_exhausted':
        return `Job ${ctx.jobName ?? ctx.jobId ?? 'unknown'} exhausted retries in ${ctx.queue ?? 'queue'}${ctx.attemptsMade ? ` (${ctx.attemptsMade} attempts)` : ''}`;
      case 'failed_backlog':
        return `Failed job backlog in ${ctx.queue ?? 'queue'}`;
      case 'no_workers_with_backlog':
        return `No workers processing ${ctx.queue ?? 'queue'}`;
      default:
        return rule.name;
    }
  }

  private matchesQueue(rule: AlertRule, queueName: string): boolean {
    if (!rule.queues || rule.queues.length === 0) return true;
    return rule.queues.includes(queueName);
  }

  private matchesJobName(rule: AlertRule, jobName: string): boolean {
    if (!rule.jobNames || rule.jobNames.length === 0) return true;
    return rule.jobNames.includes(jobName);
  }

  private pushEvent(event: AlertEvent): void {
    this.recentEvents.unshift(event);
    if (this.recentEvents.length > MAX_RECENT_EVENTS) {
      this.recentEvents.length = MAX_RECENT_EVENTS;
    }
  }

  private pushDelivery(record: AlertDeliveryRecord): void {
    this.lastDeliveries.unshift(record);
    if (this.lastDeliveries.length > MAX_DELIVERY_RECORDS) {
      this.lastDeliveries.length = MAX_DELIVERY_RECORDS;
    }
  }
}
