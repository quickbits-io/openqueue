import { defineConfig } from 'tsup';

// The React dashboard (src/ui) is built separately by Vite into `dist/ui`
// (a self-contained static SPA served from disk via UI_DIST_PATH). tsup only
// builds the server-side / framework-adapter surface, which imports nothing
// from src/ui and only depends on runtime `dependencies`.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    hono: 'src/hono.ts',
    next: 'src/next.ts',
    ui: 'src/ui/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'node18',
});
