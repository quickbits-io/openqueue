export const WORLD =
  process.env.E2E_WORLD === 'postgres' ? 'postgres' : 'bullmq';
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
export const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://openqueue:openqueue@localhost:5432/openqueue';
// The postgres world fixes its schema to `openqueue`; the BullMQ suite owns a
// private `openqueue_e2e` schema for the postgresAdapter store.
export const PG_SCHEMA = WORLD === 'postgres' ? 'openqueue' : 'openqueue_e2e';
