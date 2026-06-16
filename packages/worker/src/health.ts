import { Hono } from 'hono';

interface State {
  ready: boolean;
}

interface HealthOptions {
  metrics?: () => Promise<string>;
}

export function createHealthServer(state: State, options: HealthOptions = {}) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));
  app.get('/ready', (c) =>
    state.ready ? c.json({ ok: true }) : c.json({ ok: false }, 503),
  );
  if (options.metrics) {
    app.get('/metrics', async (c) => c.text(await options.metrics!()));
  }

  return app;
}
