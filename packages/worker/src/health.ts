import { H3 } from 'h3';

interface State {
  ready: boolean;
}

interface HealthOptions {
  metrics?: () => Promise<string>;
}

export function createHealthServer(state: State, options: HealthOptions = {}) {
  const app = new H3();

  app.get('/health', () => Response.json({ ok: true }));
  app.get('/ready', () =>
    Response.json({ ok: state.ready }, { status: state.ready ? 200 : 503 }),
  );
  if (options.metrics) {
    app.get(
      '/metrics',
      async () =>
        new Response(await options.metrics!(), {
          headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
        }),
    );
  }

  return app;
}
