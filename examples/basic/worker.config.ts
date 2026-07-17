import { defineConfig } from '@openqueue/sdk';

export default defineConfig({
  namespace: process.env.OPENQUEUE_NAMESPACE ?? 'openqueue-basic',
  dirs: ['./worker'],
  redis: { url: process.env.REDIS_URL! },
  api: { token: process.env.OPENQUEUE_API_TOKEN },
  workbench: {
    enabled: true,
    title: 'OpenQueue Basic',
    basePath: '/workbench',
  },
});
