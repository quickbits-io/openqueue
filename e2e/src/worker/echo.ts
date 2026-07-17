import { task } from '@openqueue/sdk';
import { z } from 'zod';

export const echo = task({
  id: 'echo',
  queue: 'e2e',
  schema: z.object({ value: z.string() }),
  run: async (input) => ({ echoed: input.value }),
});
