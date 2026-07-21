import { defineConfig } from 'vitest/config';

// Every suite shares the fixed `openqueue` schema, and migrate.test.ts drops it.
// Run files one at a time so schema resets never clobber a sibling file.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
