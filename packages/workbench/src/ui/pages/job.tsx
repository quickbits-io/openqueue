import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  CopyPlus,
  Download,
  ExternalLink,
  FastForward,
  Hash,
  Info,
  Layers,
  Network,
  Play,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Trash2,
  XCircle,
} from 'lucide-react';
import * as React from 'react';
import { EmptyState } from '@/components/shared/empty-state';
import { JsonViewer } from '@/components/shared/json-viewer';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { RunSpanInfo } from '@/core/types';
import { api } from '@/lib/api';
import {
  useConfig,
  useJob,
  useJobLogs,
  useJobSpans,
  usePromoteJob,
  useRemoveJob,
  useRetryJob,
} from '@/lib/hooks';
import { cn, formatAbsoluteTime, formatDuration } from '@/lib/utils';
import type { JobSearch } from '@/navigation';

interface JobPageProps {
  queueName: string;
  jobId: string;
  readonly?: boolean;
  search: JobSearch;
  onSearchChange: (search: JobSearch) => void;
  onBack: () => void;
  onClone: (queueName: string, jobName: string, payload: string) => void;
  onQueueSelect: (queueName: string) => void;
  onFlowSelect: (queueName: string, jobId: string) => void;
}

export function JobPage({
  queueName,
  jobId,
  readonly,
  search,
  onSearchChange,
  onBack,
  onClone,
  onQueueSelect,
  onFlowSelect,
}: JobPageProps) {
  const { data: job, isLoading, error } = useJob(queueName, jobId);
  const { data: config } = useConfig();
  const activeTab =
    search.tab || (job?.status === 'failed' ? 'error' : 'payload');
  const logsEnabled = activeTab === 'logs';
  const { data: jobLogs } = useJobLogs(queueName, jobId, {
    enabled: logsEnabled,
    pollWhileActive: job?.status === 'active',
  });
  const spansCapable = !!config?.capabilities.spans;
  const { data: jobSpans } = useJobSpans(queueName, jobId, {
    enabled: activeTab === 'timeline' && spansCapable,
    pollWhileActive: job?.status === 'active',
  });
  const [selectedSpanId, setSelectedSpanId] = React.useState<string | null>(
    null,
  );
  // Selection is stored by id and resolved against the freshly built tree so
  // the panel stays current while spans poll in.
  const timeline = React.useMemo(
    () => (job ? buildTimeline(job, jobSpans?.spans) : null),
    [job, jobSpans],
  );
  const selectedSpan =
    timeline && selectedSpanId
      ? findSpan(timeline.spans, selectedSpanId)
      : null;
  const panelOpen = activeTab === 'timeline' && !!selectedSpan;

  React.useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedSpanId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panelOpen]);

  const retryMutation = useRetryJob();
  const removeMutation = useRemoveJob();
  const promoteMutation = usePromoteJob();
  const [copied, setCopied] = React.useState(false);

  const actionLoading =
    retryMutation.isPending ||
    removeMutation.isPending ||
    promoteMutation.isPending;

  const handleCopyId = async () => {
    await navigator.clipboard.writeText(jobId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRetry = () => {
    retryMutation.mutate({ queueName, jobId });
  };

  const handleRemove = () => {
    removeMutation.mutate(
      { queueName, jobId },
      {
        onSuccess: () => onBack(),
      },
    );
  };

  const handlePromote = () => {
    promoteMutation.mutate({ queueName, jobId });
  };

  const handleExport = () => {
    if (!job) return;
    const exportData = {
      id: job.id,
      name: job.name,
      queueName,
      status: job.status,
      data: job.data,
      returnvalue: job.returnvalue,
      failedReason: job.failedReason,
      stacktrace: job.stacktrace,
      attemptsMade: job.attemptsMade,
      opts: job.opts,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      duration: job.duration,
      progress: job.progress,
      tags: job.tags,
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `job-${job.name}-${jobId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClone = () => {
    if (!job) return;
    const payload = JSON.stringify(job.data, null, 2);
    onClone(queueName, job.name, payload);
  };

  if (isLoading && !job) {
    return (
      <div className="space-y-4">
        {/* Header skeleton */}
        <div className=" border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="h-6 w-32 animate-pulse rounded bg-muted" />
              <div className="h-5 w-20 animate-pulse bg-muted" />
            </div>
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 animate-pulse rounded bg-muted" />
              <div className="h-8 w-8 animate-pulse rounded bg-muted" />
            </div>
          </div>
          <div className="flex items-center gap-6 px-4 py-3">
            <div className="h-4 w-24 animate-pulse rounded bg-muted" />
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            <div className="h-4 w-20 animate-pulse rounded bg-muted" />
          </div>
        </div>
        {/* Data section skeleton */}
        <div className=" border bg-card p-4">
          <div className="h-5 w-16 animate-pulse rounded bg-muted mb-3" />
          <div className="space-y-2">
            <div className="h-4 w-full animate-pulse rounded bg-muted" />
            <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !job) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Job not found"
        description={error?.message || 'This job may have been removed'}
        action={
          <Button variant="outline" onClick={onBack}>
            Go back
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex h-full gap-4">
      <div className="flex h-full min-w-0 flex-1 flex-col gap-4">
        {/* Header Card */}
        <div className=" border bg-card">
          {/* Title Row */}
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2  bg-muted px-2.5 py-1 text-sm font-medium">
                {job.name}
              </div>
              <StatusBadge status={job.status} />
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleExport}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Export
              </Button>
              {!readonly && (
                <>
                  <Button variant="outline" size="sm" onClick={handleClone}>
                    <CopyPlus className="mr-1.5 h-3.5 w-3.5" />
                    Clone
                  </Button>
                  {job.status === 'failed' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRetry}
                      disabled={actionLoading}
                    >
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      Retry
                    </Button>
                  )}
                  {job.status === 'delayed' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handlePromote}
                      disabled={actionLoading}
                    >
                      <FastForward className="mr-1.5 h-3.5 w-3.5" />
                      Run Now
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRemove}
                    disabled={actionLoading}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    Remove
                  </Button>
                </>
              )}
            </div>
          </div>

          {job.status === 'active' && (
            <div className="border-b px-4 py-2">
              <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>Progress</span>
                <span>
                  {typeof job.progress === 'number'
                    ? `${Math.round(job.progress)}%`
                    : 'Running'}
                </span>
              </div>
              <div className="h-1 bg-muted">
                <div
                  className="h-full bg-chart-2 transition-all duration-300"
                  style={{
                    width: `${
                      typeof job.progress === 'number'
                        ? Math.min(100, Math.max(0, job.progress))
                        : 100
                    }%`,
                  }}
                />
              </div>
            </div>
          )}

          {/* Metadata Rows */}
          <div className="divide-y text-sm">
            <MetadataRow icon={Hash} label="Job ID" mono>
              <span className="flex items-center gap-2">
                {jobId}
                <button
                  type="button"
                  onClick={handleCopyId}
                  className="rounded p-1 hover:bg-muted"
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-status-success" />
                  ) : (
                    <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </button>
              </span>
            </MetadataRow>
            <MetadataRow icon={Layers} label="Queue">
              <button
                type="button"
                onClick={() => onQueueSelect(queueName)}
                className="font-mono text-xs text-primary hover:underline"
              >
                {queueName}
              </button>
            </MetadataRow>
            {job.parent && (
              <MetadataRow icon={Network} label="Part of Flow">
                <button
                  type="button"
                  onClick={() =>
                    onFlowSelect(job.parent!.queueName, job.parent!.id)
                  }
                  className="flex items-center gap-1.5 text-primary hover:underline"
                >
                  <span className="font-mono text-xs">{job.parent.id}</span>
                  <ExternalLink className="h-3 w-3" />
                </button>
              </MetadataRow>
            )}
            <MetadataRow icon={Clock} label="Created">
              {formatAbsoluteTime(job.timestamp)}
            </MetadataRow>
            {job.processedOn && (
              <MetadataRow icon={Clock} label="Started">
                {formatAbsoluteTime(job.processedOn)}
              </MetadataRow>
            )}
            {job.finishedOn && (
              <MetadataRow icon={Clock} label="Finished">
                {formatAbsoluteTime(job.finishedOn)}
              </MetadataRow>
            )}
          </div>

          {/* Stats Row */}
          <div className="flex items-center gap-6 border-t px-4 py-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Duration</span>
              <span className="font-mono font-medium">
                {job.duration ? formatDuration(job.duration) : '-'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">Attempts</span>
              <span className="font-mono font-medium">
                {job.attemptsMade} / {job.opts.attempts || 3}
              </span>
              {job.attemptsMade > 1 && (
                <Badge
                  variant="secondary"
                  className="bg-amber-500/10 text-amber-600 text-[10px] px-1.5"
                >
                  Retried
                </Badge>
              )}
            </div>
            {job.opts.delay && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Delay</span>
                <span className="font-mono font-medium">
                  {formatDuration(job.opts.delay)}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Content Tabs */}
        <Tabs
          value={activeTab}
          onValueChange={(tab) =>
            onSearchChange({
              ...search,
              tab: tab as JobSearch['tab'],
            })
          }
          className="flex-1"
        >
          <TabsList>
            <TabsTrigger value="payload">Payload</TabsTrigger>
            <TabsTrigger value="output">Output</TabsTrigger>
            {job.failedReason && (
              <TabsTrigger value="error" className="text-status-error">
                Error
              </TabsTrigger>
            )}
            {job.attemptsMade > 1 &&
              job.stacktrace &&
              job.stacktrace.length > 0 && (
                <TabsTrigger value="retries">
                  Retries ({job.attemptsMade - 1})
                </TabsTrigger>
              )}
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="logs" className="gap-1.5">
              Logs
              {job.status === 'active' && (
                <Badge
                  variant="secondary"
                  className="gap-1 px-1.5 py-0 text-[10px] font-normal"
                >
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-chart-2 opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-chart-2" />
                  </span>
                  Live
                </Badge>
              )}
              {jobLogs && jobLogs.count > 0 && (
                <Badge
                  variant="secondary"
                  className="px-1.5 py-0 text-[10px] font-mono"
                >
                  {jobLogs.count}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="payload" className="mt-4">
            <div className=" border">
              <JsonViewer data={job.data} />
            </div>
          </TabsContent>

          <TabsContent value="output" className="mt-4">
            <div className=" border">
              {job.returnvalue ? (
                <JsonViewer data={job.returnvalue} />
              ) : (
                <div className="flex h-32 items-center justify-center text-muted-foreground">
                  No output data
                </div>
              )}
            </div>
          </TabsContent>

          {job.failedReason && (
            <TabsContent
              value="error"
              className="mt-4 flex flex-col"
              style={{ maxHeight: 'calc(100vh - 480px)', minHeight: '200px' }}
            >
              <ErrorDisplay
                error={job.failedReason}
                stacktrace={job.stacktrace}
                jobName={job.name}
                queueName={queueName}
              />
            </TabsContent>
          )}

          {job.attemptsMade > 1 &&
            job.stacktrace &&
            job.stacktrace.length > 0 && (
              <TabsContent value="retries" className="mt-4">
                <RetryHistory
                  attemptsMade={job.attemptsMade}
                  maxAttempts={job.opts.attempts || 3}
                  stacktraces={job.stacktrace}
                  status={job.status}
                />
              </TabsContent>
            )}

          <TabsContent value="timeline" className="mt-4">
            {timeline && (
              <Timeline
                spans={timeline.spans}
                timeRange={timeline.timeRange}
                selectedId={selectedSpanId}
                onSelect={(id) =>
                  setSelectedSpanId((prev) => (prev === id ? null : id))
                }
              />
            )}
          </TabsContent>

          <TabsContent value="logs" className="mt-4">
            <JobLogs logs={jobLogs?.logs} count={jobLogs?.count} />
          </TabsContent>
        </Tabs>
      </div>

      {panelOpen && selectedSpan && (
        <SpanDetailPanel
          span={selectedSpan}
          job={job}
          queueName={queueName}
          traceId={jobSpans?.spans?.[0]?.traceId}
          onClose={() => setSelectedSpanId(null)}
        />
      )}
    </div>
  );
}

function MetadataRow({
  icon: Icon,
  label,
  children,
  mono,
}: {
  icon: React.ElementType;
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <div className={cn(mono && 'font-mono')}>{children}</div>
    </div>
  );
}

function CursorLogo({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z" />
    </svg>
  );
}

function ErrorDisplay({
  error,
  stacktrace,
  jobName,
  queueName,
}: {
  error: string;
  stacktrace?: string[];
  jobName?: string;
  queueName?: string;
}) {
  const [expanded, setExpanded] = React.useState(true);
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    const text = stacktrace ? `${error}\n\n${stacktrace.join('\n')}` : error;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleOpenInCursor = () => {
    const errorText = stacktrace
      ? `${error}\n\n${stacktrace.join('\n')}`
      : error;
    const prompt = `Debug this error from job "${jobName || 'unknown'}" in queue "${queueName || 'unknown'}":\n\n${errorText}\n\nHelp me understand what caused this error and how to fix it.`;
    const deeplink = `https://cursor.com/link/prompt?text=${encodeURIComponent(prompt)}`;
    window.open(deeplink, '_blank');
  };

  return (
    <div className="flex flex-col h-full overflow-hidden border border-status-error/30 bg-status-error/5">
      <div className="flex items-center justify-between border-b border-status-error/30 px-4 py-2 shrink-0">
        <span className="font-medium text-status-error">{error}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleOpenInCursor}
            className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-status-error/10 hover:text-foreground"
            title="Fix in Cursor"
          >
            <CursorLogo className="shrink-0" />
            <span>Fix in Cursor</span>
          </button>
          <div className="h-4 w-px bg-border" />
          <button
            type="button"
            onClick={handleCopy}
            className="rounded p-1.5 hover:bg-status-error/10"
            title="Copy error"
          >
            {copied ? (
              <Check className="h-4 w-4 text-status-success" />
            ) : (
              <Copy className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
          {stacktrace && stacktrace.length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="rounded p-1.5 hover:bg-status-error/10"
              title={expanded ? 'Collapse' : 'Expand'}
            >
              <ChevronDown
                className={cn(
                  'h-4 w-4 text-muted-foreground transition-transform',
                  expanded && 'rotate-180',
                )}
              />
            </button>
          )}
        </div>
      </div>
      {expanded && stacktrace && stacktrace.length > 0 && (
        <div className="flex-1 overflow-auto p-4 min-h-0">
          <pre className="font-mono text-xs text-muted-foreground">
            {stacktrace.join('\n')}
          </pre>
        </div>
      )}
    </div>
  );
}

function JobLogs({ logs, count }: { logs?: string[]; count?: number }) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs?.length]);

  const handleCopy = async () => {
    if (!logs?.length) return;
    await navigator.clipboard.writeText(logs.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!logs?.length) {
    return (
      <div className="flex h-32 flex-col items-center justify-center gap-2 border bg-card text-muted-foreground">
        <ScrollText className="h-5 w-5" />
        <p className="text-sm">No logs yet</p>
        <p className="text-xs">
          Use <code className="font-mono">console.log(&quot;...&quot;)</code> or{' '}
          <code className="font-mono">ctx.logger.info(&quot;...&quot;)</code>
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col overflow-hidden border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="text-sm text-muted-foreground">
          {count ?? logs.length} log{' '}
          {(count ?? logs.length) === 1 ? 'entry' : 'entries'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Copy logs"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-status-success" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          Copy
        </button>
      </div>
      <div
        ref={scrollRef}
        className="max-h-[calc(100vh-480px)] overflow-auto p-4"
      >
        <div className="font-mono text-xs leading-relaxed text-foreground">
          {logs.map((line, index) => (
            <div
              key={index.toString()}
              className="flex gap-3 whitespace-pre-wrap"
            >
              <span className="w-8 shrink-0 select-none text-right text-muted-foreground/60">
                {index + 1}
              </span>
              <span>{line}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface TimelineProps {
  spans: Span[];
  timeRange: { start: number; end: number; duration: number };
  selectedId: string | null;
  onSelect: (id: string) => void;
}

interface Span {
  id: string;
  label: string;
  icon: React.ElementType;
  iconColor?: string;
  startTime: number;
  endTime?: number;
  status: 'success' | 'error' | 'running' | 'waiting';
  children?: Span[];
  isLog?: boolean;
  badge?: string;
  /** Backing persisted row when this node comes from real span data */
  row?: RunSpanInfo;
}

// Rows persisted before exceptions were folded into the span's error field
// carry them as 'exception' log rows (OTEL recordException semantics) instead.
function isExceptionRow(row: RunSpanInfo): boolean {
  return (
    row.kind === 'log' &&
    row.name === 'exception' &&
    (row.attributes?.['exception.message'] !== undefined ||
      row.attributes?.['exception.stacktrace'] !== undefined)
  );
}

function withLegacyError(
  row: RunSpanInfo,
  exceptions: Map<string, RunSpanInfo>,
): RunSpanInfo {
  if (row.error || row.status !== 'error') return row;
  const attrs = exceptions.get(row.spanId)?.attributes;
  if (!attrs) return row;
  const message = attrs['exception.message'];
  const name = attrs['exception.type'];
  const stack = attrs['exception.stacktrace'];
  return {
    ...row,
    error: {
      message: typeof message === 'string' ? message : 'Unknown error',
      name: typeof name === 'string' ? name : undefined,
      stack: typeof stack === 'string' ? stack : undefined,
    },
  };
}

function buildRealSpans(rows: RunSpanInfo[]): {
  roots: Span[];
  maxEnd: number;
} {
  const sorted = [...rows].sort((a, b) => a.startedAt - b.startedAt);
  const nodes = new Map<string, Span>();
  let maxEnd = 0;

  const exceptions = new Map<string, RunSpanInfo>();
  for (const row of sorted) {
    if (isExceptionRow(row)) exceptions.set(row.spanId, row);
  }

  for (const row of sorted) {
    if (row.kind !== 'span') continue;
    const end = row.startedAt + (row.durationMs ?? 0);
    maxEnd = Math.max(maxEnd, end);
    nodes.set(row.spanId, {
      id: row.id,
      label: row.name,
      icon: row.status === 'error' ? XCircle : CheckCircle2,
      iconColor:
        row.status === 'error' ? 'text-status-error' : 'text-status-success',
      startTime: row.startedAt,
      endTime: end,
      status: row.status === 'error' ? 'error' : 'success',
      children: [],
      row: withLegacyError(row, exceptions),
    });
  }

  const roots: Span[] = [];
  for (const row of sorted) {
    if (isExceptionRow(row)) continue;
    const parent = row.parentSpanId ? nodes.get(row.parentSpanId) : undefined;
    const target = parent?.children ?? roots;
    if (row.kind === 'span') {
      target.push(nodes.get(row.spanId)!);
    } else {
      maxEnd = Math.max(maxEnd, row.startedAt);
      target.push({
        id: row.id,
        label: row.name,
        icon: row.level === 'error' ? AlertCircle : Info,
        iconColor:
          row.level === 'error'
            ? 'text-status-error'
            : row.level === 'warn'
              ? 'text-amber-500'
              : 'text-blue-400',
        startTime: row.startedAt,
        status: row.level === 'error' ? 'error' : 'success',
        isLog: true,
        row,
      });
    }
  }

  return { roots, maxEnd };
}

function findSpan(spans: Span[], id: string): Span | null {
  for (const span of spans) {
    if (span.id === id) return span;
    const found = span.children ? findSpan(span.children, id) : null;
    if (found) return found;
  }
  return null;
}

// Build span tree from persisted spans when available, job data otherwise
function buildTimeline(
  job: import('../../core/types').JobInfo,
  spanRows: RunSpanInfo[] | undefined,
): {
  spans: Span[];
  timeRange: { start: number; end: number; duration: number };
} {
  const startTime = job.timestamp;
  let endTime = job.finishedOn || job.processedOn || Date.now();

  // Root job span
  const rootSpan: Span = {
    id: 'root',
    label: job.name,
    icon:
      job.status === 'completed'
        ? CheckCircle2
        : job.status === 'failed'
          ? XCircle
          : Play,
    iconColor:
      job.status === 'completed'
        ? 'text-status-success'
        : job.status === 'failed'
          ? 'text-status-error'
          : 'text-status-warning',
    startTime: job.timestamp,
    endTime: job.finishedOn,
    status:
      job.status === 'completed'
        ? 'success'
        : job.status === 'failed'
          ? 'error'
          : 'running',
    badge: job.attemptsMade > 0 ? `Attempt ${job.attemptsMade}` : undefined,
    children: [],
  };

  // Add queue wait span if there was waiting time
  if (job.processedOn && job.processedOn > job.timestamp) {
    const waitDuration = job.processedOn - job.timestamp;
    if (waitDuration > 100) {
      // Only show if > 100ms
      rootSpan.children?.push({
        id: 'wait',
        label: 'Queued',
        icon: Clock,
        iconColor: 'text-muted-foreground',
        startTime: job.timestamp,
        endTime: job.processedOn,
        status: 'waiting',
      });
    }
  }

  // Real persisted spans: attempt roots with nested spans and logs
  if (spanRows?.length) {
    const { roots, maxEnd } = buildRealSpans(spanRows);
    rootSpan.children?.push(...roots);
    if (maxEnd > endTime) endTime = maxEnd;
    return {
      spans: [rootSpan],
      timeRange: {
        start: startTime,
        end: endTime,
        duration: endTime - startTime,
      },
    };
  }

  // Add execution span
  if (job.processedOn) {
    const execSpan: Span = {
      id: 'exec',
      label: 'run()',
      icon: Play,
      iconColor: 'text-blue-500',
      startTime: job.processedOn,
      endTime: job.finishedOn,
      status:
        job.status === 'completed'
          ? 'success'
          : job.status === 'failed'
            ? 'error'
            : 'running',
      badge: job.duration ? formatDuration(job.duration) : undefined,
      children: [],
    };

    // Add progress entries as logs if progress is an object with entries
    if (job.progress && typeof job.progress === 'object') {
      const progress = job.progress as Record<string, unknown>;
      if (Array.isArray(progress.logs)) {
        for (const log of progress.logs as Array<{
          message: string;
          time?: number;
        }>) {
          execSpan.children?.push({
            id: `log-${execSpan.children.length}`,
            label: log.message,
            icon: Info,
            iconColor: 'text-blue-400',
            startTime: log.time || job.processedOn,
            status: 'success',
            isLog: true,
          });
        }
      }
    }

    // Add error as final log if failed
    if (job.status === 'failed' && job.failedReason) {
      execSpan.children?.push({
        id: 'error',
        label: job.failedReason,
        icon: AlertCircle,
        iconColor: 'text-status-error',
        startTime: job.finishedOn || job.processedOn,
        status: 'error',
        isLog: true,
      });
    }

    rootSpan.children?.push(execSpan);
  }

  return {
    spans: [rootSpan],
    timeRange: {
      start: startTime,
      end: endTime,
      duration: endTime - startTime,
    },
  };
}

function Timeline({ spans, timeRange, selectedId, onSelect }: TimelineProps) {
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({
    root: true,
    attempt: true,
  });

  const toggleExpand = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // Generate time axis labels
  const timeLabels = React.useMemo(() => {
    const { duration } = timeRange;
    const labels: { position: number; label: string }[] = [];
    const steps = 5;

    for (let i = 0; i <= steps; i++) {
      const elapsed = (duration / steps) * i;
      const relativePosition = (elapsed / duration) * 100;
      labels.push({
        position: relativePosition,
        label: formatDuration(elapsed),
      });
    }

    return labels;
  }, [timeRange]);

  const renderSpan = (span: Span, depth = 0): React.ReactNode => {
    const hasChildren = span.children && span.children.length > 0;
    const isExpanded = expanded[span.id] !== false;
    const Icon = span.icon;

    // Calculate bar position
    const barStart =
      ((span.startTime - timeRange.start) / timeRange.duration) * 100;
    const barEnd = span.endTime
      ? ((span.endTime - timeRange.start) / timeRange.duration) * 100
      : 100;
    const barWidth = Math.max(barEnd - barStart, 0.5);

    return (
      <React.Fragment key={span.id}>
        <div
          className={cn(
            'group flex min-h-[36px] cursor-pointer items-center border-b border-border/50 hover:bg-muted/30',
            selectedId === span.id && 'bg-muted/50',
          )}
          onClick={() => onSelect(span.id)}
        >
          {/* Left side - Tree */}
          <div
            className="flex w-[45%] min-w-0 items-center gap-1 py-2 pr-4"
            style={{ paddingLeft: `${depth * 20 + 12}px` }}
          >
            {/* Expand/collapse or spacer */}
            {hasChildren ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand(span.id);
                }}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-muted"
              >
                <ChevronRight
                  className={cn(
                    'h-3.5 w-3.5 text-muted-foreground transition-transform',
                    isExpanded && 'rotate-90',
                  )}
                />
              </button>
            ) : (
              <div className="w-5 shrink-0" />
            )}

            {/* Icon */}
            <Icon className={cn('h-4 w-4 shrink-0', span.iconColor)} />

            {/* Label */}
            <span
              className={cn(
                'truncate text-sm',
                span.isLog ? 'text-muted-foreground' : 'font-medium',
              )}
            >
              {span.label}
            </span>

            {/* Badge */}
            {span.badge && (
              <span className="ml-2 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {span.badge}
              </span>
            )}
          </div>

          {/* Right side - Waterfall */}
          <div className="relative h-full flex-1 py-2 pr-4">
            {span.isLog ? (
              // Log entries show as dots
              <div
                className={cn(
                  'absolute top-1/2 h-2 w-2 -translate-y-1/2 rounded-full',
                  span.status === 'error'
                    ? 'bg-status-error/70'
                    : 'bg-muted-foreground/40',
                )}
                style={{ left: `${barStart}%` }}
              />
            ) : (
              // Spans show as bars
              <div
                className={cn(
                  'absolute top-1/2 h-5 -translate-y-1/2 ',
                  span.status === 'success' && 'bg-status-success',
                  span.status === 'error' && 'bg-status-error',
                  span.status === 'running' && 'bg-status-warning',
                  span.status === 'waiting' && 'bg-muted-foreground/30',
                )}
                style={{
                  left: `${barStart}%`,
                  width: `${barWidth}%`,
                  minWidth: '2px',
                }}
              >
                {/* Duration label inside bar if wide enough */}
                {barWidth > 8 && span.endTime && (
                  <span className="absolute inset-0 flex items-center justify-center text-[10px] font-medium text-white">
                    {formatDuration(span.endTime - span.startTime)}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Children */}
        {hasChildren &&
          isExpanded &&
          span.children?.map((child) => renderSpan(child, depth + 1))}
      </React.Fragment>
    );
  };

  return (
    <div className="flex flex-col border bg-card overflow-hidden h-full">
      {/* Header with time axis */}
      <div className="flex border-b bg-muted/30 shrink-0">
        <div
          className="w-[45%] shrink-0 flex items-center py-2 pr-4"
          style={{ paddingLeft: '12px' }}
        >
          <span className="text-xs font-medium text-muted-foreground">
            Span
          </span>
        </div>
        <div className="relative flex-1 py-2 pr-4 flex items-center">
          {timeLabels.map((label, i) => (
            <span
              key={i.toString()}
              className="absolute font-mono text-[10px] text-muted-foreground"
              style={{
                left: `${label.position}%`,
                transform:
                  i === 0
                    ? 'translateX(0)'
                    : i === timeLabels.length - 1
                      ? 'translateX(-100%)'
                      : 'translateX(-50%)',
              }}
            >
              {label.label}
            </span>
          ))}
        </div>
      </div>

      {/* Spans */}
      <div className="flex-1 overflow-auto min-h-0">
        {spans.map((span) => renderSpan(span))}
      </div>
    </div>
  );
}

type PanelTab = 'overview' | 'detail' | 'metadata';

const PANEL_TABS: { id: PanelTab; label: string; shortcut: string }[] = [
  { id: 'overview', label: 'Overview', shortcut: 'O' },
  { id: 'detail', label: 'Detail', shortcut: 'D' },
  { id: 'metadata', label: 'Metadata', shortcut: 'M' },
];

function SpanDetailPanel({
  span,
  job,
  queueName,
  traceId,
  onClose,
}: {
  span: Span;
  job: import('../../core/types').JobInfo;
  queueName: string;
  traceId?: string;
  onClose: () => void;
}) {
  const row = span.row;
  const Icon = span.icon;
  const isRoot = span.id === 'root';
  const isLog = !!span.isLog;
  const [tab, setTab] = React.useState<PanelTab>('overview');
  const [downloading, setDownloading] = React.useState(false);

  const data = job.data as
    | { __input?: unknown; __runId?: unknown; __metadata?: unknown }
    | undefined;
  const payload =
    data && typeof data === 'object' && '__input' in data
      ? data.__input
      : job.data;
  const runId = typeof data?.__runId === 'string' ? data.__runId : undefined;
  const metadata =
    data?.__metadata &&
    typeof data.__metadata === 'object' &&
    Object.keys(data.__metadata).length > 0
      ? data.__metadata
      : undefined;

  React.useEffect(() => {
    if (!isRoot) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable]')) return;
      const match = PANEL_TABS.find(
        (t) => t.shortcut.toLowerCase() === e.key.toLowerCase(),
      );
      if (match) setTab(match.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isRoot]);

  const StatusIcon =
    span.status === 'success'
      ? CheckCircle2
      : span.status === 'error'
        ? XCircle
        : span.status === 'running'
          ? Play
          : Clock;
  const statusColor =
    span.status === 'success'
      ? 'text-status-success'
      : span.status === 'error'
        ? 'text-status-error'
        : span.status === 'running'
          ? 'text-status-warning'
          : 'text-muted-foreground';
  const statusLabel = isLog
    ? (row?.level ?? 'log')
    : span.status === 'success'
      ? 'Completed'
      : span.status === 'error'
        ? 'Failed'
        : span.status === 'running'
          ? 'Running'
          : 'Queued';

  const dequeuedAttr = row?.attributes?.['attempt.dequeued_at'];
  const dequeuedAt =
    typeof dequeuedAttr === 'number' && dequeuedAttr <= span.startTime
      ? dequeuedAttr
      : undefined;

  const stages: { label: string; time: number }[] = isLog
    ? [{ label: 'Logged', time: span.startTime }]
    : isRoot
      ? [
          { label: 'Triggered', time: job.timestamp },
          ...(job.processedOn
            ? [{ label: 'Started', time: job.processedOn }]
            : []),
          ...(job.finishedOn
            ? [{ label: 'Finished', time: job.finishedOn }]
            : []),
        ]
      : span.id === 'wait'
        ? [
            { label: 'Queued', time: span.startTime },
            ...(span.endTime
              ? [{ label: 'Dequeued', time: span.endTime }]
              : []),
          ]
        : [
            ...(dequeuedAt !== undefined
              ? [{ label: 'Dequeued', time: dequeuedAt }]
              : []),
            { label: 'Started', time: span.startTime },
            ...(span.endTime
              ? [{ label: 'Finished', time: span.endTime }]
              : []),
          ];

  const handleDownloadLogs = async () => {
    setDownloading(true);
    try {
      const { logs } = await api.getJobLogs(queueName, job.id);
      const blob = new Blob([logs.join('\n')], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `job-${job.name}-${job.id}-logs.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex h-full w-[400px] shrink-0 animate-in slide-in-from-right flex-col overflow-hidden border bg-card duration-200">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted">
            <Icon className={cn('h-3.5 w-3.5', span.iconColor)} />
          </span>
          <span
            className={cn(
              'truncate text-sm font-medium',
              isRoot && 'text-primary',
            )}
          >
            {span.label}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Close"
        >
          Esc
        </button>
      </div>

      {/* Tabs (job-level panel only) */}
      {isRoot && (
        <div className="flex shrink-0 items-center gap-4 border-b px-4">
          {PANEL_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                '-mb-px flex items-center gap-1.5 border-b-2 py-2 text-sm transition-colors',
                tab === t.id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
              <span className="rounded border px-1 text-[9px] text-muted-foreground">
                {t.shortcut}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {(!isRoot || tab === 'overview') && (
          <>
            {/* Status */}
            <div className="flex items-center gap-1.5 px-4 pt-4 pb-3 text-sm">
              {isLog ? (
                <span
                  className={cn(
                    'font-mono text-xs font-medium uppercase',
                    span.iconColor,
                  )}
                >
                  {statusLabel}
                </span>
              ) : (
                <>
                  <StatusIcon className={cn('h-4 w-4', statusColor)} />
                  <span className={cn('font-medium', statusColor)}>
                    {statusLabel}
                  </span>
                </>
              )}
            </div>

            {/* Lifecycle */}
            <div className="border-b px-4 pb-4">
              <LifecycleRail
                stages={stages}
                running={span.status === 'running'}
                status={span.status}
              />
            </div>

            {/* Identity (real spans) */}
            {row && !isLog && (
              <div className="space-y-1.5 border-b px-4 py-3 text-sm">
                <DetailRow label="Attempt" value={String(row.attempt)} mono />
                <DetailRow label="Span ID" value={row.spanId} mono copy />
                <DetailRow label="Trace ID" value={row.traceId} mono copy />
              </div>
            )}

            {/* Error (failed spans) */}
            {row?.error && (
              <ErrorCard
                error={row.error}
                fix={{ jobName: job.name, queueName, spanName: span.label }}
              />
            )}

            {/* Log message */}
            {isLog && <MessageBlock message={span.label} />}

            {/* Attributes */}
            {row?.attributes && Object.keys(row.attributes).length > 0 && (
              <PropertyCard
                title={isLog ? 'Properties' : 'Attributes'}
                data={row.attributes}
              />
            )}

            {/* Job payload/output */}
            {isRoot && (
              <>
                {job.failedReason && (
                  <ErrorCard
                    error={{
                      message: job.failedReason,
                      stack: job.stacktrace?.[job.stacktrace.length - 1],
                    }}
                    fix={{ jobName: job.name, queueName }}
                  />
                )}
                <PropertyCard title="Payload" data={payload} />
                {job.returnvalue != null && (
                  <PropertyCard title="Output" data={job.returnvalue} />
                )}
              </>
            )}
          </>
        )}

        {isRoot && tab === 'detail' && (
          <div className="space-y-1.5 px-4 py-4 text-sm">
            {runId && <DetailRow label="Run ID" value={runId} mono copy />}
            <DetailRow label="Job ID" value={job.id} mono copy />
            {traceId && (
              <DetailRow label="Trace ID" value={traceId} mono copy />
            )}
            <DetailRow label="Queue" value={queueName} mono />
            <DetailRow label="Status" value={job.status} />
            <DetailRow
              label="Attempts"
              value={`${job.attemptsMade} / ${job.opts.attempts || 3}`}
              mono
            />
            <DetailRow
              label="Created"
              value={formatAbsoluteTime(job.timestamp)}
            />
            {job.processedOn && (
              <DetailRow
                label="Started"
                value={formatAbsoluteTime(job.processedOn)}
              />
            )}
            {job.finishedOn && (
              <DetailRow
                label="Finished"
                value={formatAbsoluteTime(job.finishedOn)}
              />
            )}
            {job.duration != null && (
              <DetailRow
                label="Duration"
                value={formatDuration(job.duration)}
                mono
              />
            )}
            {job.opts.priority != null && (
              <DetailRow
                label="Priority"
                value={String(job.opts.priority)}
                mono
              />
            )}
            {job.opts.delay != null && job.opts.delay > 0 && (
              <DetailRow
                label="Delay"
                value={formatDuration(job.opts.delay)}
                mono
              />
            )}
            {job.tags &&
              Object.entries(job.tags).map(([key, value]) => (
                <DetailRow key={key} label={key} value={String(value)} mono />
              ))}
          </div>
        )}

        {isRoot &&
          tab === 'metadata' &&
          (metadata ? (
            <PropertyCard title="Metadata" data={metadata} />
          ) : (
            <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
              No metadata
            </div>
          ))}
      </div>

      {/* Footer */}
      {isRoot && (
        <div className="flex shrink-0 justify-end border-t px-4 py-2.5">
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownloadLogs}
            disabled={downloading}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Download logs
          </Button>
        </div>
      )}
    </div>
  );
}

function LifecycleRail({
  stages,
  running,
  status,
}: {
  stages: { label: string; time: number }[];
  running: boolean;
  status: Span['status'];
}) {
  const segmentColor =
    status === 'error'
      ? 'border-status-error'
      : status === 'running'
        ? 'border-status-warning'
        : 'border-status-success';

  return (
    <div>
      {stages.map((stage, i) => {
        const next = stages[i + 1];
        const isLast = i === stages.length - 1;
        // The execution segment (Started → Finished) carries the status color
        const colored = stage.label === 'Started';
        return (
          <div key={stage.label}>
            <div className="relative">
              <span
                className={cn(
                  'absolute left-0 top-[5px] h-[9px] w-[9px] rounded-full border-2 bg-card',
                  isLast && !running
                    ? segmentColor
                    : 'border-muted-foreground/60',
                )}
              />
              <div className="flex items-baseline justify-between pl-5">
                <span className="text-sm font-medium">{stage.label}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {formatAbsoluteTime(stage.time)}
                </span>
              </div>
            </div>
            {next && (
              <div
                className={cn(
                  'ml-[4px] border-l-2 py-1.5 pl-4',
                  colored ? segmentColor : 'border-border',
                )}
              >
                <span className="text-xs text-muted-foreground">
                  {formatDuration(next.time - stage.time)}
                </span>
              </div>
            )}
            {!next && running && (
              <div
                className={cn('ml-[4px] border-l-2 py-1.5 pl-4', segmentColor)}
              >
                <span className="text-xs text-muted-foreground">
                  Running for {formatDuration(Date.now() - stage.time)}…
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MessageBlock({ message }: { message: string }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="border-b px-4 py-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Message
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {copied ? (
            <Check className="h-3 w-3 text-status-success" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
          Copy
        </button>
      </div>
      <p className="whitespace-pre-wrap break-words font-mono text-xs">
        {message}
      </p>
    </div>
  );
}

function ErrorCard({
  error,
  fix,
}: {
  error: { message: string; name?: string; stack?: string };
  fix: { jobName: string; queueName: string; spanName?: string };
}) {
  const handleFixInCursor = () => {
    const errorText = error.stack
      ? `${error.message}\n\n${error.stack}`
      : error.message;
    const where =
      fix.spanName && fix.spanName !== fix.jobName
        ? `span "${fix.spanName}" of job "${fix.jobName}"`
        : `job "${fix.jobName}"`;
    const prompt = `Debug this error from ${where} in queue "${fix.queueName}":\n\n${errorText}\n\nHelp me understand what caused this error and how to fix it.`;
    window.open(
      `https://cursor.com/link/prompt?text=${encodeURIComponent(prompt)}`,
      '_blank',
    );
  };

  return (
    <div className="mx-4 my-3 overflow-hidden rounded-md border border-status-error/40 bg-status-error/5">
      <div className="flex items-center justify-between border-b border-status-error/30 px-3 py-1.5">
        <span className="text-xs font-medium text-status-error">
          {error.name ?? 'Error'}
        </span>
        <button
          type="button"
          onClick={handleFixInCursor}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-status-error/10 hover:text-foreground"
          title="Fix in Cursor"
        >
          <CursorLogo className="h-3 w-3 shrink-0" />
          Fix in Cursor
        </button>
      </div>
      <div className="space-y-2 p-3">
        <p className="whitespace-pre-wrap break-words text-xs font-medium text-status-error">
          {error.message}
        </p>
        {error.stack && (
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-status-error/80">
            {error.stack}
          </pre>
        )}
      </div>
    </div>
  );
}

function PropertyCard({ title, data }: { title: string; data: unknown }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mx-4 my-3 overflow-hidden rounded-md border bg-muted/30">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-xs font-medium">{title}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="rounded p-1 hover:bg-muted"
          title={`Copy ${title}`}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-status-success" />
          ) : (
            <Copy className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </button>
      </div>
      <JsonViewer data={data} className="text-xs" />
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
  copy,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copy?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn(
          'flex min-w-0 items-center gap-1.5',
          mono && 'font-mono text-xs',
        )}
      >
        <span className="truncate" title={value}>
          {value}
        </span>
        {copy && (
          <button
            type="button"
            onClick={handleCopy}
            className="shrink-0 rounded p-0.5 hover:bg-muted"
            title={`Copy ${label}`}
          >
            {copied ? (
              <Check className="h-3 w-3 text-status-success" />
            ) : (
              <Copy className="h-3 w-3 text-muted-foreground" />
            )}
          </button>
        )}
      </span>
    </div>
  );
}

// Retry History component
interface RetryHistoryProps {
  attemptsMade: number;
  maxAttempts: number;
  stacktraces: string[];
  status: string;
}

function RetryHistory({
  attemptsMade,
  maxAttempts,
  stacktraces,
  status,
}: RetryHistoryProps) {
  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center gap-4  border bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-2">
          <RotateCcw className="h-4 w-4 text-amber-500" />
          <span className="font-medium">Retry History</span>
        </div>
        <div className="text-sm text-muted-foreground">
          {attemptsMade} of {maxAttempts} attempts
        </div>
        <Badge
          variant={status === 'completed' ? 'default' : 'destructive'}
          className="ml-auto"
        >
          {status === 'completed'
            ? 'Eventually succeeded'
            : 'All attempts failed'}
        </Badge>
      </div>

      {/* Attempt list */}
      <div className="space-y-3">
        {stacktraces.map((trace, index) => (
          <RetryAttemptCard
            key={index.toString()}
            attemptNumber={index + 1}
            isLast={index === stacktraces.length - 1}
            stacktrace={trace}
            succeeded={
              status === 'completed' && index === stacktraces.length - 1
            }
          />
        ))}
      </div>
    </div>
  );
}

interface RetryAttemptCardProps {
  attemptNumber: number;
  isLast: boolean;
  stacktrace: string;
  succeeded: boolean;
}

function RetryAttemptCard({
  attemptNumber,
  isLast,
  stacktrace,
  succeeded,
}: RetryAttemptCardProps) {
  const [expanded, setExpanded] = React.useState(isLast);

  // Parse error message from stacktrace (first line usually)
  const errorMessage = stacktrace.split('\n')[0] || 'Unknown error';

  return (
    <div
      className={cn(
        'overflow-hidden  border',
        succeeded
          ? 'border-status-success/30 bg-status-success/5'
          : 'border-status-error/30 bg-status-error/5',
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left"
      >
        <div
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium',
            succeeded
              ? 'bg-status-success/20 text-status-success'
              : 'bg-status-error/20 text-status-error',
          )}
        >
          {attemptNumber}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Attempt {attemptNumber}</span>
            {succeeded ? (
              <Badge
                variant="secondary"
                className="bg-status-success/10 text-status-success text-[10px]"
              >
                Success
              </Badge>
            ) : (
              <Badge
                variant="secondary"
                className="bg-status-error/10 text-status-error text-[10px]"
              >
                Failed
              </Badge>
            )}
          </div>
          {!succeeded && (
            <div className="truncate text-xs text-muted-foreground">
              {errorMessage}
            </div>
          )}
        </div>
        <ChevronDown
          className={cn(
            'h-4 w-4 text-muted-foreground transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {expanded && !succeeded && (
        <div className="border-t border-inherit px-4 py-3">
          <pre className="max-h-48 overflow-auto font-mono text-xs text-muted-foreground whitespace-pre-wrap">
            {stacktrace}
          </pre>
        </div>
      )}

      {expanded && succeeded && (
        <div className="border-t border-inherit px-4 py-3 text-sm text-status-success">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            Job completed successfully on this attempt
          </div>
        </div>
      )}
    </div>
  );
}
