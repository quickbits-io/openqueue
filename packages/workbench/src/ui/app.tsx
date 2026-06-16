import { RouterProvider } from '@tanstack/react-router';
import { useMemo } from 'react';
import type { HeaderSource } from './lib/api-base';
import { WorkbenchProvider } from './provider';
import { createAppRouter } from './router';

// Get base path from the <base> tag or default to "/"
function getBasePath() {
  if (typeof document !== 'undefined') {
    const base = document.querySelector('base');
    if (base?.href) {
      const url = new URL(base.href);
      return url.pathname.replace(/\/$/, '') || '/';
    }
  }
  return '/';
}

// Create router with detected base path
export interface DashboardProps {
  basePath?: string;
  apiBase?: string;
  apiRoot?: string;
  headers?: HeaderSource;
  shell?: boolean;
}

export function App({
  basePath,
  apiBase,
  apiRoot,
  headers,
  shell = true,
}: DashboardProps) {
  const router = useMemo(
    () => createAppRouter(basePath ?? getBasePath()),
    [basePath],
  );

  return (
    <WorkbenchProvider apiBase={apiBase} apiRoot={apiRoot} headers={headers}>
      <RouterProvider router={router} context={{ shell }} />
    </WorkbenchProvider>
  );
}
