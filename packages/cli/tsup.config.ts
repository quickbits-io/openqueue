import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm'],
  dts: false,
  sourcemap: false,
  clean: !options.watch,
  target: 'node18',
  // Preserve the `#!/usr/bin/env bun` shebang and mark the output executable.
  shims: false,
}));
