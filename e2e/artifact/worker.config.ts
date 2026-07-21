import { defineConfig } from '@openqueue/sdk';
// Statically importing a task module makes the config graph touch task files,
// so a boot.mjs that imports the config *before* snapshotting the registry
// would clobber it to zero — the smoke's `/info tasks >= 1` assertion catches
// exactly that ordering regression.
import './worker/echo';

export default defineConfig({
  namespace: process.env.OPENQUEUE_NAMESPACE ?? 'artifact-smoke',
  dirs: ['./worker'],
  redis: { url: process.env.REDIS_URL! },
  workbench: { enabled: true },
  api: { token: 'artifact-smoke' },
});
