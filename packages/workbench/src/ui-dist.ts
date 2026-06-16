import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute filesystem path to the bundled UI assets (index.html + /assets).
 * Adapters that don't go through {@link createFetchHandler} serve static
 * files from this directory directly.
 */
export const UI_DIST_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'ui',
);
