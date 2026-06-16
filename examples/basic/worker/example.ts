import { task } from '@openqueue/sdk';
import { z } from 'zod';

export const example = task({
  id: 'example',
  schema: z.object({
    message: z.string().default('Hello from OpenQueue'),
  }),
  run: async (payload, ctx) => {
    ctx.logger.info('received message', { message: payload.message });
    await ctx.progress({ step: 'done' });
    return { ok: true };
  },
});
