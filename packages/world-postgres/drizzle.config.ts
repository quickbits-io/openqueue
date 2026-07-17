import { defineConfig } from 'drizzle-kit';

// Maintainer artifact: input to `bun run migrations:generate`. `generate` is
// offline (diffs src/schema.ts against the committed snapshot), so no
// dbCredentials are needed. `MIGRATIONS_OUT` lets the generator regenerate into
// a scratch directory for the `--check` drift gate.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: process.env.MIGRATIONS_OUT ?? './drizzle',
  schemaFilter: ['openqueue'],
});
