/**
 * `@openqueue/workbench/ui` — React entrypoint for embedding the Workbench
 * dashboard inside a host Vite/React app (e.g. the Tauri desktop client).
 *
 * Consumers import the `Dashboard` component, render it inside their own
 * provider tree, and optionally point it at a non-relative API base via
 * `setApiBase()` or the global `window.__WORKBENCH_RUNTIME__.apiBase`.
 *
 * The bundled `dist/ui/` build (used by adapters that serve UI from the
 * server) does **not** consume this entrypoint — it goes through
 * `src/ui/main.tsx`.
 */
export { App as Dashboard, type DashboardProps } from './app';
export {
  apiBase,
  apiRoot,
  getConfigUrl,
  type HeaderSource,
  joinApi,
  requestHeaders,
  setApiBase,
  setApiRoot,
  setRequestHeaders,
} from './lib/api-base';
export {
  createWorkbenchHref,
  type JobSearch,
  jobSearchSchema,
  parseJobSearch,
  parseQueueSearch,
  parseRunsSearch,
  parseSchedulersSearch,
  parseTestSearch,
  type QueueSearch,
  queueSearchSchema,
  type RunsSearch,
  runsSearchSchema,
  type SchedulersSearch,
  schedulersSearchSchema,
  type TestSearch,
  testSearchSchema,
  useWorkbenchNavigation,
  type WorkbenchNavigation,
  WorkbenchNavigationProvider,
  type WorkbenchTarget,
  workbenchNavItems,
} from './navigation';
export { WorkbenchProvider, type WorkbenchProviderProps } from './provider';
export { createAppRouter } from './router';
export {
  Alerts,
  Errors,
  Flow,
  Flows,
  Job,
  Jobs,
  Metrics,
  Queue,
  Runs,
  Schedulers,
  type ScreenProps,
  type SearchScreenProps,
  Test,
  Workbench,
} from './screens';
