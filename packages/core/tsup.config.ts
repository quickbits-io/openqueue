import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: {
    index: 'src/index.ts',
    auth: 'src/auth.ts',
    control: 'src/control.ts',
    drizzle: 'src/drizzle.ts',
    types: 'src/types.ts',
    world: 'src/world.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  // Watch mode must not wipe dist at startup: dependents (worker, examples)
  // boot against these files while `turbo run dev` is coming up.
  clean: !options.watch,
  treeshake: true,
  target: 'node18',
}));
