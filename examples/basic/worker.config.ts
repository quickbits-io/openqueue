import { defineConfig } from '@openqueue/sdk';

export default defineConfig({
  namespace: process.env.OPENQUEUE_NAMESPACE ?? 'openqueue-basic',
  dirs: ['./worker'],
  redis: { url: process.env.REDIS_URL! },
  workbench: {
    enabled: true,
    title: 'OpenQueue Basic',
    basePath: '/workbench',
  },
});
