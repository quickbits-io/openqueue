import { AlertTriangle, Bug, Layers, ListX } from 'lucide-react';
import { SummaryCard } from '@/components/metrics/summary-card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { FailingJobType } from '@/core/types';
import { useErrors } from '@/lib/hooks';
import { cn, formatRelativeTime, truncate } from '@/lib/utils';

function formatPercentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function MiniTrend({ values }: { values?: number[] }) {
  const series = values?.length ? values : Array.from({ length: 24 }, () => 0);
  const max = Math.max(...series, 1);

  return (
    <div className="flex h-7 w-28 items-end gap-px" aria-hidden="true">
      {series.map((value, index) => (
        <span
          key={`${index}-${value}`}
          className={cn(
            'block w-full bg-status-error/25',
            value > 0 && 'bg-status-error/80',
          )}
          style={{ height: `${Math.max(2, (value / max) * 28)}px` }}
        />
      ))}
    </div>
  );
}

interface ErrorsPageProps {
  onJobSelect: (queueName: string, jobId: string) => void;
  onQueueFailedSelect: (queueName: string) => void;
}

function ErrorRows({
  jobs,
  onJobSelect,
  onQueueFailedSelect,
}: {
  jobs: FailingJobType[];
  onJobSelect: (queueName: string, jobId: string) => void;
  onQueueFailedSelect: (queueName: string) => void;
}) {
  if (jobs.length === 0) {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center gap-2 border border-dashed bg-card text-center">
        <ListX className="h-5 w-5 text-muted-foreground" />
        <p className="text-sm font-medium">No errors in the last 24 hours</p>
        <p className="text-xs text-muted-foreground">
          Failed jobs will appear here grouped by queue, job, and error class.
        </p>
      </div>
    );
  }

  return (
    <div className="border border-dashed bg-card">
      <div className="hidden grid-cols-[minmax(0,1.6fr)_112px_120px_120px] gap-4 border-b border-dashed px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground md:grid">
        <span>Error group</span>
        <span>Frequency</span>
        <span>Latest</span>
        <span>24h trend</span>
      </div>
      <div className="divide-y divide-border">
        {jobs.map((job) => {
          const handleSelect = () => {
            if (job.jobId) {
              onJobSelect(job.queueName, job.jobId);
            } else {
              onQueueFailedSelect(job.queueName);
            }
          };

          return (
            <button
              key={`${job.queueName}-${job.name}-${job.errorClass ?? 'JobError'}`}
              type="button"
              onClick={handleSelect}
              className="block w-full bg-transparent px-4 py-3 text-left hover:bg-muted/30 md:grid md:grid-cols-[minmax(0,1.6fr)_112px_120px_120px] md:items-center md:gap-4"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge
                    variant="outline"
                    className="shrink-0 border-status-error/50 font-mono text-[10px] text-status-error"
                  >
                    {job.errorClass ?? 'JobError'}
                  </Badge>
                  <span className="truncate text-sm font-medium">
                    {job.name}
                  </span>
                </div>
                <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <span className="truncate font-mono">{job.queueName}</span>
                  {job.latestFailedReason && (
                    <>
                      <span className="shrink-0">/</span>
                      <span className="truncate">
                        {truncate(job.latestFailedReason, 120)}
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between gap-3 md:mt-0 md:justify-start">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground md:hidden">
                  Frequency
                </span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm tabular-nums">
                    {job.failCount.toLocaleString()}
                  </span>
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    {formatPercentage(job.errorRate)}
                  </Badge>
                </div>
              </div>

              <div className="mt-2 flex items-center justify-between gap-3 md:mt-0 md:block">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground md:hidden">
                  Latest
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {job.latestFailedAt
                    ? formatRelativeTime(job.latestFailedAt)
                    : '-'}
                </span>
              </div>

              <div className="mt-3 flex items-center justify-between gap-3 md:mt-0">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground md:hidden">
                  24h trend
                </span>
                <MiniTrend values={job.trend} />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        {['failed', 'rate', 'queues', 'groups'].map((id) => (
          <div key={id} className="space-y-3 border border-dashed p-4">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-6 w-20" />
          </div>
        ))}
      </div>
      <div className="space-y-2 border border-dashed p-4">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}

export function ErrorsPage({
  onJobSelect,
  onQueueFailedSelect,
}: ErrorsPageProps) {
  const { data: errors, isLoading, error } = useErrors();

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  if (error || !errors) {
    return (
      <div className="border border-destructive/50 bg-destructive/10 p-4">
        <p className="text-destructive">
          {error instanceof Error ? error.message : 'Failed to load errors'}
        </p>
      </div>
    );
  }

  const { summary, buckets, groups } = errors;
  const failedSparkline = buckets.map((bucket) => bucket.failed);
  const errorRateSparkline = buckets.map((bucket) => {
    const total = bucket.completed + bucket.failed;
    return total > 0 ? bucket.failed / total : 0;
  });
  const affectedQueues = new Set(groups.map((job) => job.queueName));
  const affectedJobTypes = new Set(
    groups.map((job) => `${job.queueName}:${job.name}`),
  );

  const midpoint = Math.floor(buckets.length / 2);
  const previousFailed = buckets
    .slice(0, midpoint)
    .reduce((sum, bucket) => sum + bucket.failed, 0);
  const currentFailed = buckets
    .slice(midpoint)
    .reduce((sum, bucket) => sum + bucket.failed, 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        <SummaryCard
          title="Failed Jobs"
          value={summary.totalFailed.toLocaleString()}
          subtitle="last 24 hours"
          sparklineData={failedSparkline}
          sparklineColor="danger"
          trend={{
            current: currentFailed,
            previous: previousFailed,
            higherIsBetter: false,
          }}
          icon={<AlertTriangle className="h-4 w-4" />}
        />
        <SummaryCard
          title="Error Rate"
          value={formatPercentage(summary.errorRate)}
          subtitle={`${summary.totalFailed.toLocaleString()} failures`}
          sparklineData={errorRateSparkline}
          sparklineColor={summary.errorRate > 0.1 ? 'danger' : 'warning'}
          icon={<Bug className="h-4 w-4" />}
        />
        <SummaryCard
          title="Queues"
          value={affectedQueues.size.toLocaleString()}
          subtitle="with grouped failures"
          icon={<Layers className="h-4 w-4" />}
        />
        <SummaryCard
          title="Groups"
          value={groups.length.toLocaleString()}
          subtitle={`${affectedJobTypes.size.toLocaleString()} job types`}
          icon={<ListX className="h-4 w-4" />}
        />
      </div>

      <ErrorRows
        jobs={groups}
        onJobSelect={onJobSelect}
        onQueueFailedSelect={onQueueFailedSelect}
      />
    </div>
  );
}
