import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import * as React from 'react';
import { AppSidebar, type NavItem } from '@/components/app-sidebar';
import { CommandPalette } from '@/components/layout/command-palette';
import { HeaderSearch } from '@/components/layout/header-search';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { useConfig, useQueueNames, useQueues } from '@/lib/hooks';
import {
  createWorkbenchHref,
  type JobSearch,
  jobSearchSchema,
  type QueueSearch,
  queueSearchSchema,
  runsSearchSchema,
  type SchedulersSearch,
  schedulersSearchSchema,
  type TestSearch,
  testSearchSchema,
  type WorkbenchNavigation,
  WorkbenchNavigationProvider,
  type WorkbenchTarget,
} from '@/navigation';
import { Workbench } from '@/screens';

// Context for sharing search state across routes
interface SearchContextValue {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  setCommandOpen: (open: boolean) => void;
}

const SearchContext = React.createContext<SearchContextValue | null>(null);

export function useSearchContext() {
  const context = React.useContext(SearchContext);
  if (!context) {
    throw new Error(
      'useSearchContext must be used within SearchContextProvider',
    );
  }
  return context;
}

interface DashboardContext {
  shell: boolean;
}

// Helper to parse sort string
export function parseSort(
  sort?: string,
): { field: string; direction: 'asc' | 'desc' } | undefined {
  if (!sort) return undefined;
  const [field, dir] = sort.split(':');
  if (!field) return undefined;
  return { field, direction: dir === 'asc' ? 'asc' : 'desc' };
}

// Helper to create sort string
export function createSort(field: string, direction: 'asc' | 'desc'): string {
  return `${field}:${direction}`;
}

const rootRoute = createRootRouteWithContext<DashboardContext>()({
  component: RootLayout,
});

// Root layout component
function RootLayout() {
  const { shell } = rootRoute.useRouteContext();
  const { data: config, isLoading: loading } = useConfig();
  // Use fast queue names for sidebar (no counts, instant)
  useQueueNames();
  // Lazy load full queue info for paused state (loads in background)
  const { data: queuesData = [] } = useQueues();
  const navigate = useNavigate();
  const navigateTarget = React.useCallback(
    (target: WorkbenchTarget, replace = false) => {
      switch (target.name) {
        case 'jobs':
          navigate({ to: '/', replace });
          break;
        case 'runs':
          navigate({ to: '/runs', search: target.search, replace });
          break;
        case 'errors':
          navigate({ to: '/errors', replace });
          break;
        case 'metrics':
          navigate({ to: '/metrics', replace });
          break;
        case 'schedulers':
          navigate({ to: '/schedulers', search: target.search, replace });
          break;
        case 'flows':
          navigate({ to: '/flows', replace });
          break;
        case 'flow':
          navigate({
            to: '/flows/$queueName/$jobId',
            params: { queueName: target.queueName, jobId: target.jobId },
            replace,
          });
          break;
        case 'queue':
          navigate({
            to: '/queues/$queueName',
            params: { queueName: target.queueName },
            search: target.search,
            replace,
          });
          break;
        case 'job':
          navigate({
            to: '/queues/$queueName/jobs/$jobId',
            params: { queueName: target.queueName, jobId: target.jobId },
            search: target.search,
            replace,
          });
          break;
        case 'test':
          navigate({ to: '/test', search: target.search, replace });
          break;
        case 'alerts':
          navigate({ to: '/alerts', replace });
          break;
      }
    },
    [navigate],
  );
  const navigation = React.useMemo<WorkbenchNavigation>(
    () => ({
      href: createWorkbenchHref,
      push: (target) => navigateTarget(target),
      replace: (target) => navigateTarget(target, true),
    }),
    [navigateTarget],
  );

  // Derive paused queues set (from lazy-loaded full queue data)
  const pausedQueues = React.useMemo(() => {
    return new Set(queuesData.filter((q) => q.isPaused).map((q) => q.name));
  }, [queuesData]);
  const location = useLocation();
  const [commandOpen, setCommandOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [isDark, setIsDark] = React.useState(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('workbench:theme');
      if (stored) return stored === 'dark';
      return true;
    }
    return true;
  });

  // Derive active nav and queue from location
  const { activeNav, activeQueue } = React.useMemo(() => {
    const path = location.pathname;
    if (path === '/' || path === '') {
      return { activeNav: 'overview' as NavItem, activeQueue: undefined };
    }
    if (path === '/runs') {
      return { activeNav: 'runs' as NavItem, activeQueue: undefined };
    }
    if (path === '/errors') {
      return { activeNav: 'errors' as NavItem, activeQueue: undefined };
    }
    if (path === '/metrics') {
      return { activeNav: 'metrics' as NavItem, activeQueue: undefined };
    }
    if (path === '/schedulers') {
      return { activeNav: 'schedulers' as NavItem, activeQueue: undefined };
    }
    if (path === '/flows' || path.startsWith('/flows/')) {
      return { activeNav: 'flows' as NavItem, activeQueue: undefined };
    }
    if (path === '/test') {
      return { activeNav: 'test' as NavItem, activeQueue: undefined };
    }
    if (path === '/alerts') {
      return { activeNav: 'alerts' as NavItem, activeQueue: undefined };
    }
    if (path.startsWith('/queues/')) {
      const queueName = path.split('/')[2];
      return { activeNav: 'queues' as NavItem, activeQueue: queueName };
    }
    return { activeNav: 'runs' as NavItem, activeQueue: undefined };
  }, [location.pathname]);

  // Toggle dark mode (disable transitions during switch)
  React.useEffect(() => {
    document.documentElement.classList.add('no-transitions');
    document.documentElement.classList.toggle('dark', isDark);
    localStorage.setItem('workbench:theme', isDark ? 'dark' : 'light');
    // Re-enable transitions after the theme switch
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.documentElement.classList.remove('no-transitions');
      });
    });
  }, [isDark]);

  // Keyboard shortcuts
  React.useEffect(() => {
    if (!shell) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      // Command palette shortcut
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommandOpen(true);
        return;
      }
      // Don't handle other shortcuts when command palette is open (let cmdk handle them)
      if (commandOpen) return;
      const shortcutRoutes: Record<string, string> = {
        '1': '/',
        '2': '/runs',
        '3': '/errors',
        '4': '/metrics',
        '5': '/schedulers',
        '6': '/flows',
        '7': '/alerts',
        '8': '/test',
      };
      const shortcutRoute = shortcutRoutes[e.key];
      if ((e.metaKey || e.ctrlKey) && shortcutRoute) {
        e.preventDefault();
        navigate({ to: shortcutRoute });
        return;
      }
      // Refresh shortcut
      if (e.key === 'r' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        window.location.reload();
      }
      // Theme toggle shortcut
      if (e.key === 't' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
        e.preventDefault();
        setIsDark(!isDark);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [commandOpen, isDark, navigate, shell]);

  if (loading || !config) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  const handleNavSelect = (nav: NavItem) => {
    switch (nav) {
      case 'overview':
        navigate({ to: '/' });
        break;
      case 'runs':
        navigate({ to: '/runs' });
        break;
      case 'errors':
        navigate({ to: '/errors' });
        break;
      case 'metrics':
        navigate({ to: '/metrics' });
        break;
      case 'schedulers':
        navigate({ to: '/schedulers' });
        break;
      case 'flows':
        navigate({ to: '/flows' });
        break;
      case 'alerts':
        navigate({ to: '/alerts' });
        break;
      case 'test':
        navigate({ to: '/test' });
        break;
      case 'queues':
        // Just expand the queues section, don't navigate
        break;
    }
  };

  const handleQueueSelect = (queue: string) => {
    navigate({ to: '/queues/$queueName', params: { queueName: queue } });
  };

  const content = (
    <SearchContext.Provider
      value={{ searchQuery, setSearchQuery, setCommandOpen }}
    >
      <WorkbenchNavigationProvider navigation={navigation}>
        <Outlet />
      </WorkbenchNavigationProvider>
    </SearchContext.Provider>
  );

  const overlays = shell ? (
    <CommandPalette
      open={commandOpen}
      onOpenChange={setCommandOpen}
      queues={config.queues}
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      isDark={isDark}
      onToggleTheme={() => setIsDark(!isDark)}
      onSelectQueue={(queue) => {
        navigate({ to: '/queues/$queueName', params: { queueName: queue } });
        setCommandOpen(false);
      }}
      onSelectJob={(queue, jobId) => {
        navigate({
          to: '/queues/$queueName/jobs/$jobId',
          params: { queueName: queue, jobId },
        });
        setCommandOpen(false);
      }}
      onNavigate={(path) => {
        navigate({ to: path });
        setCommandOpen(false);
      }}
    />
  ) : null;

  if (!shell) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background text-foreground">
        {content}
        {overlays}
      </div>
    );
  }

  return (
    <SidebarProvider defaultOpen={false} className="h-full">
      <div className="flex h-full min-h-0 w-full">
        <AppSidebar
          queues={config.queues}
          pausedQueues={pausedQueues}
          activeNav={activeNav}
          activeQueue={activeQueue}
          onNavSelect={handleNavSelect}
          onQueueSelect={handleQueueSelect}
          isDark={isDark}
          onToggleTheme={() => setIsDark(!isDark)}
          logo={config.logo}
        />

        <SidebarInset className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {content}
        </SidebarInset>
      </div>

      {overlays}
    </SidebarProvider>
  );
}

// Page wrapper with header
function PageLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const { shell } = rootRoute.useRouteContext();
  const context = useSearchContext();

  if (!shell) {
    return <main className="flex-1 overflow-auto p-6">{children}</main>;
  }

  return (
    <>
      <header className="relative z-20 flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && (
            <span className="hidden font-mono text-sm text-muted-foreground sm:inline">
              {subtitle}
            </span>
          )}
        </div>
        <HeaderSearch
          value={context.searchQuery}
          onValueChange={context.setSearchQuery}
          onFocus={() => context.setCommandOpen(true)}
        />
      </header>
      <main className="flex-1 overflow-auto p-6">{children}</main>
    </>
  );
}

function OverviewRoute() {
  return (
    <PageLayout title="Jobs">
      <Workbench.Jobs />
    </PageLayout>
  );
}

// Route components - all pages eagerly loaded for instant navigation
function RunsRoute() {
  const search = useSearch({ from: '/runs' });

  return (
    <PageLayout title="Runs">
      <Workbench.Runs search={search} />
    </PageLayout>
  );
}

function SchedulersRoute() {
  const search = useSearch({ from: '/schedulers' }) as SchedulersSearch;

  return (
    <PageLayout title="Schedulers">
      <Workbench.Schedulers search={search} />
    </PageLayout>
  );
}

function MetricsRoute() {
  return (
    <PageLayout title="Metrics">
      <Workbench.Metrics />
    </PageLayout>
  );
}

function ErrorsRoute() {
  return (
    <PageLayout title="Errors">
      <Workbench.Errors />
    </PageLayout>
  );
}

function FlowsRoute() {
  return (
    <PageLayout title="Flows">
      <Workbench.Flows />
    </PageLayout>
  );
}

function FlowDetailRoute() {
  const { queueName, jobId } = useParams({ from: '/flows/$queueName/$jobId' });

  return (
    <PageLayout title="Flow Details" subtitle={jobId}>
      <Workbench.Flow queueName={queueName} jobId={jobId} />
    </PageLayout>
  );
}

function TestRoute() {
  const search = useSearch({ from: '/test' }) as TestSearch;
  return (
    <PageLayout title="Test">
      <Workbench.Test search={search} />
    </PageLayout>
  );
}

function AlertsRoute() {
  return (
    <PageLayout title="Alerts">
      <Workbench.Alerts />
    </PageLayout>
  );
}

function QueueRoute() {
  const { queueName } = useParams({ from: '/queues/$queueName' });
  const search = useSearch({ from: '/queues/$queueName' }) as QueueSearch;

  return (
    <PageLayout title={queueName}>
      <Workbench.Queue queueName={queueName} search={search} />
    </PageLayout>
  );
}

function JobRoute() {
  const { queueName, jobId } = useParams({
    from: '/queues/$queueName/jobs/$jobId',
  });
  const search = useSearch({
    from: '/queues/$queueName/jobs/$jobId',
  }) as JobSearch;

  return (
    <PageLayout title="Job Details" subtitle={jobId}>
      <Workbench.Job queueName={queueName} jobId={jobId} search={search} />
    </PageLayout>
  );
}

// Route definitions
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: OverviewRoute,
});

const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs',
  component: RunsRoute,
  validateSearch: runsSearchSchema,
});

const metricsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/metrics',
  component: MetricsRoute,
});

const errorsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/errors',
  component: ErrorsRoute,
});

const schedulersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/schedulers',
  component: SchedulersRoute,
  validateSearch: schedulersSearchSchema,
});

const flowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/flows',
  component: FlowsRoute,
});

const flowDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/flows/$queueName/$jobId',
  component: FlowDetailRoute,
});

const testRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/test',
  component: TestRoute,
  validateSearch: testSearchSchema,
});

const alertsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/alerts',
  component: AlertsRoute,
});

const queueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/queues/$queueName',
  component: QueueRoute,
  validateSearch: queueSearchSchema,
});

const jobRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/queues/$queueName/jobs/$jobId',
  component: JobRoute,
  validateSearch: jobSearchSchema,
});

// Route tree
const routeTree = rootRoute.addChildren([
  indexRoute,
  runsRoute,
  errorsRoute,
  metricsRoute,
  schedulersRoute,
  flowsRoute,
  flowDetailRoute,
  testRoute,
  alertsRoute,
  queueRoute,
  jobRoute,
]);

// Create and export router
export function createAppRouter(basePath: string) {
  return createRouter({
    routeTree,
    basepath: basePath,
    context: {
      shell: true,
    },
  });
}

// Type declaration for router
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
