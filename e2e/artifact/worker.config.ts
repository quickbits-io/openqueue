import { defineConfig } from '@openqueue/sdk';

export default defineConfig({
  namespace: process.env.OPENQUEUE_NAMESPACE ?? 'artifact-smoke',
  dirs: ['./worker'],
  redis: { url: process.env.REDIS_URL! },
  workbench: { enabled: true },
  api: { token: 'artifact-smoke' },
});
