import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm'],
  dts: false,
  sourcemap: false,
  clean: true,
  target: 'node18',
  // Preserve the `#!/usr/bin/env bun` shebang and mark the output executable.
  shims: false,
});
