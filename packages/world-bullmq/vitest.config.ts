import { defineConfig } from 'vitest/config';

// The real-Redis suites share one server, and the ownership test asserts on the
// global `connected_clients` count — which concurrent files would churn. Run
// files one at a time so connection accounting stays stable.
export default defineConfig({
  test: {
    globals: true,
    fileParallelism: false,
  },
});
