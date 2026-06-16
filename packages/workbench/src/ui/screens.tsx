'use client';

import type * as React from 'react';
import { useConfig } from './lib/hooks';
import {
  type JobSearch,
  type QueueSearch,
  type RunsSearch,
  type SchedulersSearch,
  type TestSearch,
  useOptionalWorkbenchNavigation,
  type WorkbenchNavigation,
} from './navigation';
import { AlertsPage } from './pages/alerts';
import { ErrorsPage } from './pages/errors';
import { FlowPage } from './pages/flow';
import { FlowsPage } from './pages/flows';
import { JobPage } from './pages/job';
import { MetricsPage } from './pages/metrics';
import { OverviewPage } from './pages/overview';
import { QueuePage } from './pages/queue';
import { RunsPage } from './pages/runs';
import { SchedulersPage } from './pages/schedulers';
import { TestPage } from './pages/test';

export type ScreenProps = {
  className?: string;
  navigation?: WorkbenchNavigation;
};

export type SearchScreenProps<T> = ScreenProps & {
  search?: T;
  onSearchChange?: (search: T, options?: { replace?: boolean }) => void;
};

type QueueProps = SearchScreenProps<QueueSearch> & {
  queueName: string;
};

type JobProps = SearchScreenProps<JobSearch> & {
  queueName: string;
  jobId: string;
};

type FlowProps = ScreenProps & {
  queueName: string;
  jobId: string;
};

function Frame({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  if (!className) return <>{children}</>;
  return <div className={className}>{children}</div>;
}

function useNavigation(navigation?: WorkbenchNavigation) {
  const context = useOptionalWorkbenchNavigation();
  const resolved = navigation ?? context;
  if (!resolved) {
    throw new Error(
      'Workbench screens must be rendered inside WorkbenchProvider with navigation.',
    );
  }
  return resolved;
}

export function Jobs({ className, navigation }: ScreenProps) {
  const nav = useNavigation(navigation);

  return (
    <Frame className={className}>
      <OverviewPage
        onQueueSelect={(queueName) => nav.push({ name: 'queue', queueName })}
        onViewFailed={(queueName) =>
          nav.push({
            name: 'queue',
            queueName,
            search: { status: 'failed' },
          })
        }
        onMetricsSelect={() => nav.push({ name: 'metrics' })}
      />
    </Frame>
  );
}

export function Runs({
  className,
  navigation,
  search = {},
  onSearchChange,
}: SearchScreenProps<RunsSearch>) {
  const nav = useNavigation(navigation);

  return (
    <Frame className={className}>
      <RunsPage
        search={search}
        onSearchChange={(nextSearch) => {
          if (onSearchChange) {
            onSearchChange(nextSearch, { replace: true });
          } else {
            nav.replace({ name: 'runs', search: nextSearch });
          }
        }}
        onJobSelect={(queueName, jobId) =>
          nav.push({ name: 'job', queueName, jobId })
        }
        onQueueSelect={(queueName) => nav.push({ name: 'queue', queueName })}
      />
    </Frame>
  );
}

export function Errors({ className, navigation }: ScreenProps) {
  const nav = useNavigation(navigation);

  return (
    <Frame className={className}>
      <ErrorsPage
        onJobSelect={(queueName, jobId) =>
          nav.push({ name: 'job', queueName, jobId })
        }
        onQueueFailedSelect={(queueName) =>
          nav.push({
            name: 'queue',
            queueName,
            search: { status: 'failed' },
          })
        }
      />
    </Frame>
  );
}

export function Metrics({ className, navigation }: ScreenProps) {
  const nav = useNavigation(navigation);

  return (
    <Frame className={className}>
      <MetricsPage
        onJobSelect={(queueName, jobId) =>
          nav.push({ name: 'job', queueName, jobId })
        }
        onQueueFailedSelect={(queueName) =>
          nav.push({
            name: 'queue',
            queueName,
            search: { status: 'failed' },
          })
        }
      />
    </Frame>
  );
}

export function Schedulers({
  className,
  navigation,
  search = {},
  onSearchChange,
}: SearchScreenProps<SchedulersSearch>) {
  const nav = useNavigation(navigation);

  return (
    <Frame className={className}>
      <SchedulersPage
        search={search}
        onSearchChange={(nextSearch) => {
          if (onSearchChange) {
            onSearchChange(nextSearch, { replace: true });
          } else {
            nav.replace({ name: 'schedulers', search: nextSearch });
          }
        }}
        onJobSelect={(queueName, jobId) =>
          nav.push({ name: 'job', queueName, jobId })
        }
      />
    </Frame>
  );
}

export function Flows({ className, navigation }: ScreenProps) {
  const nav = useNavigation(navigation);

  return (
    <Frame className={className}>
      <FlowsPage
        onFlowSelect={(queueName, jobId) =>
          nav.push({ name: 'flow', queueName, jobId })
        }
        onQueueSelect={(queueName) => nav.push({ name: 'queue', queueName })}
      />
    </Frame>
  );
}

export function Flow({ className, navigation, queueName, jobId }: FlowProps) {
  const nav = useNavigation(navigation);

  return (
    <Frame className={className}>
      <FlowPage
        queueName={queueName}
        jobId={jobId}
        onJobSelect={(targetQueue, targetJobId) =>
          nav.push({
            name: 'job',
            queueName: targetQueue,
            jobId: targetJobId,
          })
        }
        onQueueSelect={(targetQueue) =>
          nav.push({ name: 'queue', queueName: targetQueue })
        }
      />
    </Frame>
  );
}

export function Queue({
  className,
  navigation,
  queueName,
  search = {},
  onSearchChange,
}: QueueProps) {
  const nav = useNavigation(navigation);
  const { data: config } = useConfig();

  return (
    <Frame className={className}>
      <QueuePage
        queueName={queueName}
        readonly={config?.readonly}
        search={search}
        onSearchChange={(nextSearch) => {
          if (onSearchChange) {
            onSearchChange(nextSearch, { replace: true });
          } else {
            nav.replace({ name: 'queue', queueName, search: nextSearch });
          }
        }}
        onJobSelect={(jobId) => nav.push({ name: 'job', queueName, jobId })}
      />
    </Frame>
  );
}

export function Job({
  className,
  navigation,
  queueName,
  jobId,
  search = {},
  onSearchChange,
}: JobProps) {
  const nav = useNavigation(navigation);
  const { data: config } = useConfig();

  return (
    <Frame className={className}>
      <JobPage
        queueName={queueName}
        jobId={jobId}
        readonly={config?.readonly}
        search={search}
        onSearchChange={(nextSearch) => {
          if (onSearchChange) {
            onSearchChange(nextSearch, { replace: true });
          } else {
            nav.replace({ name: 'job', queueName, jobId, search: nextSearch });
          }
        }}
        onBack={() => nav.push({ name: 'queue', queueName })}
        onClone={(queue, jobName, payload) =>
          nav.push({
            name: 'test',
            search: { queue, jobName, payload },
          })
        }
        onQueueSelect={(targetQueue) =>
          nav.push({ name: 'queue', queueName: targetQueue })
        }
        onFlowSelect={(targetQueue, targetJobId) =>
          nav.push({
            name: 'flow',
            queueName: targetQueue,
            jobId: targetJobId,
          })
        }
      />
    </Frame>
  );
}

export function Test({ className, search }: SearchScreenProps<TestSearch>) {
  const { data: config } = useConfig();

  return (
    <Frame className={className}>
      <TestPage
        registry={config?.registry}
        readonly={config?.readonly}
        prefill={search}
      />
    </Frame>
  );
}

export function Alerts({ className }: ScreenProps) {
  return (
    <Frame className={className}>
      <AlertsPage />
    </Frame>
  );
}

export const Workbench = {
  Jobs,
  Runs,
  Errors,
  Metrics,
  Schedulers,
  Flows,
  Flow,
  Queue,
  Job,
  Test,
  Alerts,
};
