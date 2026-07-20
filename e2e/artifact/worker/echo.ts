import { task } from '@openqueue/sdk';
import { z } from 'zod';

export const echo = task({
  id: 'echo',
  queue: 'artifact',
  schema: z.object({
    message: z.string().default('hello'),
    // A drain-test job passes a sleep longer than srvx's 5s graceful window to
    // prove the in-flight job still completes on SIGTERM.
    sleepMs: z.number().int().nonnegative().default(0),
  }),
  run: async (input) => {
    if (input.sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, input.sleepMs));
    }
    return { echoed: input.message };
  },
});
