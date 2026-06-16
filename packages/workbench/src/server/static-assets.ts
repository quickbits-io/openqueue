import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UI_DIST_PATH } from '../ui-dist';

export interface StaticAssetResult {
  status: 200 | 404;
  body: Buffer | null;
  contentType: string;
}

/**
 * Read a bundled UI asset from `UI_DIST_PATH/assets/<filename>`.
 *
 * Returns a uniform `{ status, body, contentType }` shape so each adapter
 * can serialize it onto its framework-native response without re-implementing
 * the file lookup or content-type sniffing.
 */
export function serveStaticAsset(filename: string): StaticAssetResult {
  return serveUiFile(join('assets', filename));
}

/**
 * Read a bundled UI file from `UI_DIST_PATH/<filename>`.
 * Used for root-level assets like `app-icon.svg` that Vite copies from `public/`.
 */
export function serveUiFile(relativePath: string): StaticAssetResult {
  const filePath = join(UI_DIST_PATH, relativePath);

  if (!existsSync(filePath)) {
    return { status: 404, body: null, contentType: 'text/plain' };
  }

  const body = readFileSync(filePath);
  const filename = relativePath.split('/').pop() ?? relativePath;
  const contentType = filename.endsWith('.js')
    ? 'application/javascript'
    : filename.endsWith('.css')
      ? 'text/css'
      : filename.endsWith('.svg')
        ? 'image/svg+xml'
        : filename.endsWith('.png')
          ? 'image/png'
          : filename.endsWith('.ico')
            ? 'image/x-icon'
            : filename.endsWith('.woff2')
              ? 'font/woff2'
              : 'application/octet-stream';

  return { status: 200, body, contentType };
}

export interface IndexHtmlResult {
  body: string;
  contentType: 'text/html; charset=utf-8';
}

/**
 * Read the bundled `index.html`, inject a `<base href>` matching the request's
 * mount path so client-side asset URLs resolve correctly, and return it.
 *
 * Falls back to a tiny "UI assets not found" stub when the core package has
 * not been built yet — useful for `bun run dev` against a fresh checkout.
 */
export function renderIndexHtml(
  basePath: string,
  title: string,
): IndexHtmlResult {
  const indexPath = join(UI_DIST_PATH, 'index.html');

  if (existsSync(indexPath)) {
    let html = readFileSync(indexPath, 'utf-8');
    html = html.replace('<head>', `<head>\n    <base href="${basePath}">`);
    return { body: html, contentType: 'text/html; charset=utf-8' };
  }

  return {
    body: fallbackHtml(title, basePath),
    contentType: 'text/html; charset=utf-8',
  };
}

function fallbackHtml(title: string, basePath: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <base href="${basePath}">
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <link rel="icon" href="./app-icon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="./app-icon.svg" />
    <style>
      body {
        font-family: system-ui, sans-serif;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        margin: 0;
        background: #0a0a0a;
        color: #fafafa;
      }
      .message {
        text-align: center;
        padding: 2rem;
      }
      code {
        background: #1a1a1a;
        padding: 0.5rem 1rem;
        border-radius: 0.5rem;
        display: block;
        margin-top: 1rem;
      }
    </style>
  </head>
  <body>
    <div class="message">
      <h1>${title}</h1>
      <p>UI assets not found. Build @openqueue/workbench first:</p>
      <code>bun run --filter=@openqueue/workbench build</code>
    </div>
  </body>
</html>`;
}
