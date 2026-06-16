import type { QueueDrain, QueueDrainEvent } from './types';

export function composeDrains(
  ...drains: Array<QueueDrain | undefined | false | null>
): QueueDrain {
  const active = drains.filter((drain): drain is QueueDrain => Boolean(drain));

  return {
    name: 'composed',
    handle: async (event: QueueDrainEvent) => {
      if (active.length === 0) return;
      await Promise.allSettled(active.map((drain) => drain.handle(event)));
    },
  };
}
