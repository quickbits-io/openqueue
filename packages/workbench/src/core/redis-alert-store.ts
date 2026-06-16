import type { RedisOptions } from 'ioredis';
import { Redis } from 'ioredis';
import { isRecord, safeJsonParse } from '../util';
import type {
  AlertContactPoint,
  AlertRule,
  AlertStore,
  AlertsOptions,
} from './types';

type RedisConnection = string | (RedisOptions & { url?: string });

export interface RedisAlertStoreOptions {
  connection: RedisConnection;
  /** BullMQ-style prefix; keys are `${prefix}:workbench:alerts:*` */
  prefix?: string;
  /** Imported once when Redis has no stored config yet */
  seed?: Pick<AlertsOptions, 'contactPoints' | 'rules'>;
}

function createRedisClient(connection: RedisConnection): Redis {
  if (typeof connection === 'string') {
    return new Redis(connection, { maxRetriesPerRequest: null });
  }
  const { url, ...rest } = connection;
  if (url) {
    return new Redis(url, { ...rest, maxRetriesPerRequest: null });
  }
  return new Redis({ ...rest, maxRetriesPerRequest: null });
}

function isAlertContactPoint(value: unknown): value is AlertContactPoint {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.preset === 'string' &&
    typeof value.url === 'string' &&
    typeof value.enabled === 'boolean'
  );
}

function isAlertRule(value: unknown): value is AlertRule {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.enabled === 'boolean' &&
    typeof value.trigger === 'string' &&
    typeof value.severity === 'string' &&
    Array.isArray(value.contactPointIds)
  );
}

/**
 * Persists alert contact points and rules in the user's Redis.
 * Webhook URLs and rules created in the dashboard survive process restarts.
 */
export class RedisAlertStore implements AlertStore {
  private readonly client: Redis;
  private readonly contactPointsKey: string;
  private readonly rulesKey: string;
  private readonly seed?: Pick<AlertsOptions, 'contactPoints' | 'rules'>;
  private seeded = false;

  constructor(options: RedisAlertStoreOptions) {
    this.client = createRedisClient(options.connection);
    const prefix = options.prefix ?? 'bull';
    this.contactPointsKey = `${prefix}:workbench:alerts:contact-points`;
    this.rulesKey = `${prefix}:workbench:alerts:rules`;
    this.seed = options.seed;
  }

  async close(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }

  private async ensureSeeded(): Promise<void> {
    if (this.seeded) return;
    this.seeded = true;

    const [cpCount, ruleCount] = await Promise.all([
      this.client.hlen(this.contactPointsKey),
      this.client.hlen(this.rulesKey),
    ]);

    if (cpCount > 0 || ruleCount > 0) return;
    if (!this.seed?.contactPoints?.length && !this.seed?.rules?.length) return;

    const pipeline = this.client.pipeline();
    for (const cp of this.seed.contactPoints ?? []) {
      pipeline.hset(this.contactPointsKey, cp.id, JSON.stringify(cp));
    }
    for (const rule of this.seed.rules ?? []) {
      pipeline.hset(this.rulesKey, rule.id, JSON.stringify(rule));
    }
    await pipeline.exec();
  }

  private async readHash<T>(
    key: string,
    isValid: (value: unknown) => value is T,
  ): Promise<T[]> {
    const raw = await this.client.hgetall(key);
    const items: T[] = [];
    for (const value of Object.values(raw)) {
      const parsed = safeJsonParse(value);
      // skip corrupt or shape-invalid entries
      if (isValid(parsed)) items.push(parsed);
    }
    return items;
  }

  async getContactPoints(): Promise<AlertContactPoint[]> {
    await this.ensureSeeded();
    const items = await this.readHash(
      this.contactPointsKey,
      isAlertContactPoint,
    );
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getContactPoint(id: string): Promise<AlertContactPoint | undefined> {
    await this.ensureSeeded();
    const raw = await this.client.hget(this.contactPointsKey, id);
    if (!raw) return undefined;
    const parsed = safeJsonParse(raw);
    return isAlertContactPoint(parsed) ? parsed : undefined;
  }

  async createContactPoint(
    input: Omit<AlertContactPoint, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<AlertContactPoint> {
    await this.ensureSeeded();
    const now = Date.now();
    const cp: AlertContactPoint = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    await this.client.hset(this.contactPointsKey, cp.id, JSON.stringify(cp));
    return cp;
  }

  async updateContactPoint(
    id: string,
    input: Partial<Omit<AlertContactPoint, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<AlertContactPoint | undefined> {
    await this.ensureSeeded();
    const existing = await this.getContactPoint(id);
    if (!existing) return undefined;
    const updated: AlertContactPoint = {
      ...existing,
      ...input,
      id,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    };
    await this.client.hset(this.contactPointsKey, id, JSON.stringify(updated));
    return updated;
  }

  async deleteContactPoint(id: string): Promise<boolean> {
    await this.ensureSeeded();
    const removed = await this.client.hdel(this.contactPointsKey, id);
    return removed > 0;
  }

  async getRules(): Promise<AlertRule[]> {
    await this.ensureSeeded();
    const items = await this.readHash(this.rulesKey, isAlertRule);
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getRule(id: string): Promise<AlertRule | undefined> {
    await this.ensureSeeded();
    const raw = await this.client.hget(this.rulesKey, id);
    if (!raw) return undefined;
    const parsed = safeJsonParse(raw);
    return isAlertRule(parsed) ? parsed : undefined;
  }

  async createRule(
    input: Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<AlertRule> {
    await this.ensureSeeded();
    const now = Date.now();
    const rule: AlertRule = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    await this.client.hset(this.rulesKey, rule.id, JSON.stringify(rule));
    return rule;
  }

  async updateRule(
    id: string,
    input: Partial<Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<AlertRule | undefined> {
    await this.ensureSeeded();
    const existing = await this.getRule(id);
    if (!existing) return undefined;
    const updated: AlertRule = {
      ...existing,
      ...input,
      id,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    };
    await this.client.hset(this.rulesKey, id, JSON.stringify(updated));
    return updated;
  }

  async deleteRule(id: string): Promise<boolean> {
    await this.ensureSeeded();
    const removed = await this.client.hdel(this.rulesKey, id);
    return removed > 0;
  }
}
