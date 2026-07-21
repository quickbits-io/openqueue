import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

describe('queue drizzle schema', () => {
  it('creates tables under a custom Postgres schema', async () => {
    const { defineQueueSchema } = await import('../drizzle.js');
    const schema = defineQueueSchema({ schema: 'jobs' });
    const schedules = getTableConfig(schema.queueSchedules);

    expect(schedules.schema).toBe('jobs');
    expect(schedules.name).toBe('schedules');
    expect(getTableConfig(schema.queueCatalog).schema).toBe('jobs');
  });
});
