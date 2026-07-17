import { createClient } from '@openqueue/sdk/client';

// Fetch-only client for a deployed worker — no Redis/DB in the app. Points at
// the `examples/basic` worker by default.
export const openqueue = createClient({
  host: process.env.OPENQUEUE_URL ?? 'http://localhost:8090',
  ...(process.env.OPENQUEUE_API_TOKEN
    ? { auth: { bearer: process.env.OPENQUEUE_API_TOKEN } }
    : {}),
});
