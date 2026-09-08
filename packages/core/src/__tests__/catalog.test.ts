import { describe, expect, it } from 'vitest';
import { catalogEntryDefinition, taskCatalogEntry } from '../catalog';
import { task } from '../task';

describe('task catalog', () => {
  it('round-trips the delivery options a queue consumer needs', () => {
    const def = task({
      id: 'slow-report',
      maxStalledCount: 2,
      maxDuration: 60_000,
      run: async () => undefined,
    });

    const entry = taskCatalogEntry(def);
    expect(entry.maxStalledCount).toBe(2);
    expect(entry.maxDuration).toBe(60_000);
    expect(catalogEntryDefinition(entry)).toMatchObject({
      id: 'slow-report',
      maxStalledCount: 2,
      maxDuration: 60_000,
    });
  });
});
