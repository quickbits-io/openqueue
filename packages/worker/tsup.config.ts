import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: {
    index: 'src/index.ts',
    nitro: 'src/nitro.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: !options.watch,
  treeshake: true,
  target: 'node18',
}));
