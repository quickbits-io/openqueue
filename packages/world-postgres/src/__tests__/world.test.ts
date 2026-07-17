import { validateWorld } from '@openqueue/core/world';
import { describe, expect, it } from 'vitest';
import { worldPostgres } from '../world';
import { DATABASE_URL, hasDb, testClient } from './test-db';

const ctx = { namespace: { namespace: 'world-test', bullPrefix: 'bull' } };

describe.runIf(hasDb)('worldPostgres', () => {
  it('builds a world that passes validateWorld', async () => {
    const world = await worldPostgres({ url: DATABASE_URL })(ctx);
    expect(() => validateWorld(world)).not.toThrow();
    expect(world.specVersion).toBe(1);
    expect(world.transport.id).toBe('postgres');
    expect(world.transport.capabilities.flows).toBe(false);
    expect(world.migrations?.steps.length).toBeGreaterThan(0);
    await world.close();
  });

  it('requires exactly one of url or db', async () => {
    expect(() => worldPostgres({})).toThrow(/exactly one/);
    const sql = testClient();
    expect(() => worldPostgres({ url: DATABASE_URL, db: sql })).toThrow(
      /exactly one/,
    );
    await sql.end();
  });

  it('leaves an injected client open on close, ends an owned one', async () => {
    const sql = testClient();
    const injected = await worldPostgres({ db: sql })(ctx);
    await injected.close();
    // The injected client is untouched — still usable after the world closed.
    const rows = await sql<{ ok: number }[]>`select 1 as ok`;
    expect(rows[0]?.ok).toBe(1);
    await sql.end();

    // An owned (url) client is ended by close; a never-connected one ends cleanly.
    const owned = await worldPostgres({ url: DATABASE_URL })(ctx);
    await expect(owned.close()).resolves.toBeUndefined();
  });
});
