import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      // Task files discovered/imported at runtime do `import { task } from
      // '@openqueue/core'`. Resolve that bare specifier to this package's own
      // source so they share the same module instance — and therefore the same
      // task registry — as the code under test. (The published package resolves
      // the specifier to ./dist via `exports`.)
      '@openqueue/core': fileURLToPath(
        new URL('./src/index.ts', import.meta.url),
      ),
    },
  },
});
