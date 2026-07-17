import { memoryQueueStorage } from './store/memory';
import { createLocalTransport } from './transport/local';
import {
  type OpenQueueWorld,
  WORLD_SPEC_VERSION,
  type WorldContext,
} from './world';

/**
 * An in-process world: the local transport paired with in-memory storage.
 * Owns nothing external — `close()` just tears the transport down.
 */
export function worldLocal(): (ctx: WorldContext) => OpenQueueWorld {
  return () => {
    const transport = createLocalTransport();
    const store = memoryQueueStorage();
    return {
      specVersion: WORLD_SPEC_VERSION,
      transport,
      store,
      close: async () => {
        await transport.close();
      },
    };
  };
}
