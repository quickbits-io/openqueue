import { defineConfig } from 'drizzle-kit';
import { DATABASE_URL, PG_SCHEMA } from './src/env';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/queue-schema.ts',
  dbCredentials: { url: DATABASE_URL },
  schemaFilter: [PG_SCHEMA],
});
