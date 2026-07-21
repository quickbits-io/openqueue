import { defineConfig, postgresAdapter } from '@openqueue/sdk';
import { worldBullmq } from '@openqueue/world-bullmq';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { queueSchema } from './schema';

// The composed, two-axis world: BullMQ (Redis) delivers jobs, Postgres persists
// schedules and run history. `redis: { url }` is the one-line sugar for exactly
// this; here we spell it out to show the transport and the store as separate
// choices.
const db = drizzle(postgres(process.env.DATABASE_URL!));

export default defineConfig({
  namespace: process.env.OPENQUEUE_NAMESPACE ?? 'openqueue-basic',
  dirs: ['./worker'],
  world: worldBullmq({
    url: process.env.REDIS_URL!,
    storage: postgresAdapter({ db, schema: queueSchema }),
  }),
  api: { token: process.env.OPENQUEUE_API_TOKEN },
  workbench: {
    enabled: true,
    title: 'OpenQueue Basic',
    basePath: '/workbench',
  },
});
