import { useQueryClient } from '@tanstack/react-query';
import cronstrue from 'cronstrue';
import {
  AlertCircle,
  CalendarClock,
  Check,
  CheckCircle,
  ChevronRight,
  Clock,
  Copy,
  Globe,
  Hash,
  Layers,
  Loader2,
  Play,
  Power,
  PowerOff,
  Repeat,
  Timer,
  Trash2,
} from 'lucide-react';
import { type ElementType, type ReactNode, useState } from 'react';
import { EmptyState } from '@/components/shared/empty-state';
import { RelativeTime } from '@/components/shared/relative-time';
import { SortableHeader, useSort } from '@/components/shared/sortable-header';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { DynamicScheduleInfo, SchedulerInfo } from '@/core/types';
import {
  useActivateDynamicSchedule,
  useConfig,
  useDeactivateDynamicSchedule,
  useDelayedSchedulers,
  useDeleteDynamicSchedule,
  useDynamicSchedules,
  useRefresh,
  useRepeatableSchedulers,
  useRunDynamicSchedule,
  useRunScheduler,
  useSchedulerDetail,
} from '@/lib/hooks';
import { cn, formatAbsoluteTime, formatDuration } from '@/lib/utils';
import type { SchedulersSearch } from '@/navigation';

interface SchedulersPageProps {
  search: SchedulersSearch;
  onSearchChange: (search: SchedulersSearch) => void;
  onJobSelect: (queueName: string, jobId: string) => void;
}

export function SchedulersPage({
  search,
  onSearchChange,
  onJobSelect,
}: SchedulersPageProps) {
  const _queryClient = useQueryClient();

  // Sort hooks
  const { currentSort: repeatableSort, handleSort: handleRepeatableSort } =
    useSort(search.repeatableSort, (sort) =>
      onSearchChange({ ...search, repeatableSort: sort }),
    );
  const { currentSort: delayedSort, handleSort: handleDelayedSort } = useSort(
    search.delayedSort,
    (sort) => onSearchChange({ ...search, delayedSort: sort }),
  );
  const { currentSort: dynamicSort, handleSort: handleDynamicSort } = useSort(
    search.dynamicSort,
    (sort) => onSearchChange({ ...search, dynamicSort: sort }),
  );
  const { data: config } = useConfig();
  const dynamicEnabled = !!config?.capabilities.dynamicSchedules;

  const {
    data: repeatable = [],
    isLoading: repeatableLoading,
    error: repeatableError,
    isRefetching: repeatableRefetching,
  } = useRepeatableSchedulers(search.repeatableSort);
  const {
    data: delayed = [],
    isLoading: delayedLoading,
    error: delayedError,
    isRefetching: delayedRefetching,
  } = useDelayedSchedulers(search.delayedSort);
  const {
    data: dynamic = [],
    isLoading: dynamicLoading,
    error: dynamicError,
    isRefetching: dynamicRefetching,
  } = useDynamicSchedules(search.dynamicSort, dynamicEnabled);

  // Server-side cache refresh
  const refreshMutation = useRefresh();

  // Detail sheet: the repeatable scheduler whose detail panel is open.
  const [selected, setSelected] = useState<SchedulerInfo | null>(null);

  // "Run now" confirmation dialog state
  const runScheduler = useRunScheduler();
  const runDynamicSchedule = useRunDynamicSchedule();
  const activateDynamicSchedule = useActivateDynamicSchedule();
  const deactivateDynamicSchedule = useDeactivateDynamicSchedule();
  const deleteDynamicSchedule = useDeleteDynamicSchedule();
  const [runTarget, setRunTarget] = useState<SchedulerInfo | null>(null);
  const [dynamicRunTarget, setDynamicRunTarget] =
    useState<DynamicScheduleInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DynamicScheduleInfo | null>(
    null,
  );
  const [runResult, setRunResult] = useState<
    | { success: true; jobId: string }
    | { success: false; message: string }
    | null
  >(null);

  const closeRunDialog = () => {
    setRunTarget(null);
    setDynamicRunTarget(null);
    setRunResult(null);
  };

  const confirmRun = () => {
    if (!runTarget && !dynamicRunTarget) return;
    setRunResult(null);
    const callbacks = {
      onSuccess: (res: { id: string }) =>
        setRunResult({ success: true, jobId: res.id }),
      onError: (err: Error) =>
        setRunResult({ success: false, message: err.message }),
    };
    if (dynamicRunTarget) {
      runDynamicSchedule.mutate(dynamicRunTarget.id, callbacks);
    } else if (runTarget) {
      runScheduler.mutate(
        { queueName: runTarget.queueName, schedulerKey: runTarget.key },
        callbacks,
      );
    }
  };

  // Open the just-triggered job, closing the dialog first.
  const openTriggeredJob = (jobId: string) => {
    const queueName = runTarget?.queueName;
    if (!queueName) return;
    closeRunDialog();
    onJobSelect(queueName, jobId);
  };

  const _loading =
    repeatableLoading ||
    delayedLoading ||
    dynamicLoading ||
    repeatableRefetching ||
    delayedRefetching ||
    dynamicRefetching ||
    refreshMutation.isPending;
  const error = repeatableError || delayedError || dynamicError;

  const _refresh = () => {
    refreshMutation.mutate();
  };

  if (
    repeatableLoading ||
    delayedLoading ||
    (dynamicEnabled && dynamicLoading)
  ) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="h-7 w-32 animate-pulse rounded bg-muted" />
          <div className="h-9 w-9 animate-pulse rounded bg-muted" />
        </div>
        <div className="space-y-4">
          <div className="flex gap-2">
            <div className="h-9 w-32 animate-pulse rounded bg-muted" />
            <div className="h-9 w-28 animate-pulse rounded bg-muted" />
          </div>
          {/* Table Header */}
          <div className="grid grid-cols-12 gap-4 border-b border-dashed py-2.5 text-[11px] uppercase tracking-wider text-muted-foreground">
            <div className="col-span-3">Name</div>
            <div className="col-span-2">Queue</div>
            <div className="col-span-2">Pattern</div>
            <div className="col-span-2">Next Run</div>
            <div className="col-span-2">Timezone</div>
            <div className="col-span-1" />
          </div>
          {/* Skeleton Rows */}
          <div className="divide-y divide-border/50">
            {[...Array(10)].map((_, i) => (
              <div
                key={`pulse-${i.toString()}`}
                className="grid grid-cols-12 items-center gap-4 py-3"
              >
                <div className="col-span-3 flex items-center gap-2">
                  <div className="h-4 w-4 animate-pulse rounded bg-muted" />
                  <div className="h-4 w-24 animate-pulse rounded bg-muted" />
                </div>
                <div className="col-span-2">
                  <div className="h-3 w-16 animate-pulse rounded bg-muted" />
                </div>
                <div className="col-span-2">
                  <div className="h-4 w-20 animate-pulse rounded bg-muted" />
                </div>
                <div className="col-span-2">
                  <div className="h-4 w-24 animate-pulse rounded bg-muted" />
                </div>
                <div className="col-span-2">
                  <div className="h-3 w-16 animate-pulse rounded bg-muted" />
                </div>
                <div className="col-span-1 flex justify-end">
                  <div className="h-8 w-8 animate-pulse rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Failed to load schedulers"
        description={error.message}
      />
    );
  }

  return (
    <div className="space-y-6">
      <Tabs
        value={
          dynamicEnabled
            ? search.tab || 'repeatable'
            : search.tab === 'delayed'
              ? 'delayed'
              : 'repeatable'
        }
        onValueChange={(tab) =>
          onSearchChange({
            ...search,
            tab: tab as 'repeatable' | 'delayed' | 'dynamic',
          })
        }
      >
        <TabsList>
          <TabsTrigger value="repeatable">
            Repeatable ({repeatable.length})
          </TabsTrigger>
          <TabsTrigger value="delayed">Delayed ({delayed.length})</TabsTrigger>
          {dynamicEnabled ? (
            <TabsTrigger value="dynamic">
              Dynamic ({dynamic.length})
            </TabsTrigger>
          ) : null}
        </TabsList>

        <TabsContent value="repeatable" className="mt-4">
          {repeatable.length === 0 ? (
            <EmptyState
              icon={Clock}
              title="No repeatable jobs"
              description="No cron or repeating jobs are configured"
            />
          ) : (
            <div className="divide-y divide-border/50">
              {/* Header */}
              <div className="grid grid-cols-12 gap-4 border-b border-dashed py-2.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                <div className="col-span-3">
                  <SortableHeader
                    field="name"
                    label="Name"
                    currentSort={repeatableSort}
                    onSort={handleRepeatableSort}
                  />
                </div>
                <div className="col-span-2">
                  <SortableHeader
                    field="queueName"
                    label="Queue"
                    currentSort={repeatableSort}
                    onSort={handleRepeatableSort}
                  />
                </div>
                <div className="col-span-2">
                  <SortableHeader
                    field="pattern"
                    label="Pattern"
                    currentSort={repeatableSort}
                    onSort={handleRepeatableSort}
                  />
                </div>
                <div className="col-span-2">
                  <SortableHeader
                    field="next"
                    label="Next Run"
                    currentSort={repeatableSort}
                    onSort={handleRepeatableSort}
                  />
                </div>
                <div className="col-span-2">
                  <SortableHeader
                    field="tz"
                    label="Timezone"
                    currentSort={repeatableSort}
                    onSort={handleRepeatableSort}
                  />
                </div>
                <div className="col-span-1" />
              </div>

              {/* Rows */}
              {repeatable.map((scheduler) => (
                <div
                  key={scheduler.key}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelected(scheduler)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelected(scheduler);
                    }
                  }}
                  className="grid cursor-pointer grid-cols-12 items-center gap-4 py-3 text-sm transition-colors hover:bg-muted/40"
                >
                  <div className="col-span-3 flex items-center gap-2">
                    <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">
                      {scheduler.name}
                    </span>
                  </div>
                  <div className="col-span-2 truncate font-mono text-xs text-muted-foreground">
                    {scheduler.queueName}
                  </div>
                  <div className="col-span-2 font-mono text-xs">
                    {scheduler.pattern ||
                      (scheduler.every
                        ? `every ${formatDuration(scheduler.every)}`
                        : '-')}
                  </div>
                  <div className="col-span-2 text-muted-foreground">
                    {scheduler.next ? (
                      <RelativeTime timestamp={scheduler.next} />
                    ) : (
                      '-'
                    )}
                  </div>
                  <div className="col-span-2 text-xs text-muted-foreground">
                    {scheduler.tz || 'UTC'}
                  </div>
                  <div className="col-span-1 flex justify-end">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRunResult(null);
                            setRunTarget(scheduler);
                          }}
                        >
                          <Play className="h-4 w-4" />
                          <span className="sr-only">Run now</span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="left">Run now</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="delayed" className="mt-4">
          {delayed.length === 0 ? (
            <EmptyState
              icon={Timer}
              title="No delayed jobs"
              description="No jobs are scheduled for future execution"
            />
          ) : (
            <div className="divide-y divide-border/50">
              {/* Header */}
              <div className="grid grid-cols-12 gap-4 border-b border-dashed py-2.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                <div className="col-span-3">
                  <SortableHeader
                    field="name"
                    label="Name"
                    currentSort={delayedSort}
                    onSort={handleDelayedSort}
                  />
                </div>
                <div className="col-span-2">
                  <SortableHeader
                    field="queueName"
                    label="Queue"
                    currentSort={delayedSort}
                    onSort={handleDelayedSort}
                  />
                </div>
                <div className="col-span-3">Job ID</div>
                <div className="col-span-2">
                  <SortableHeader
                    field="processAt"
                    label="Executes"
                    currentSort={delayedSort}
                    onSort={handleDelayedSort}
                  />
                </div>
                <div className="col-span-2">
                  <SortableHeader
                    field="delay"
                    label="Delay"
                    currentSort={delayedSort}
                    onSort={handleDelayedSort}
                  />
                </div>
              </div>

              {/* Rows */}
              {delayed.map((job) => (
                <div
                  key={`${job.queueName}-${job.id}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onJobSelect(job.queueName, job.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onJobSelect(job.queueName, job.id);
                    }
                  }}
                  className="grid cursor-pointer grid-cols-12 items-center gap-4 py-3 text-sm transition-colors hover:bg-muted/40"
                >
                  <div className="col-span-3 flex items-center gap-2">
                    <Timer className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">{job.name}</span>
                  </div>
                  <div className="col-span-2 truncate font-mono text-xs text-muted-foreground">
                    {job.queueName}
                  </div>
                  <div className="col-span-3 truncate font-mono text-xs text-muted-foreground">
                    {job.id}
                  </div>
                  <div className="col-span-2 text-muted-foreground">
                    <RelativeTime timestamp={job.processAt} />
                  </div>
                  <div className="col-span-2 text-muted-foreground">
                    {formatDuration(job.delay)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {dynamicEnabled ? (
          <TabsContent value="dynamic" className="mt-4">
            {dynamic.length === 0 ? (
              <EmptyState
                icon={CalendarClock}
                title="No dynamic schedules"
                description="No storage-backed schedules are configured"
              />
            ) : (
              <div className="divide-y divide-border/50">
                <div className="grid grid-cols-12 gap-4 border-b border-dashed py-2.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <div className="col-span-3">Task</div>
                  <div className="col-span-2">External ID</div>
                  <div className="col-span-2">
                    <SortableHeader
                      field="nextRun"
                      label="Next Run"
                      currentSort={dynamicSort}
                      onSort={handleDynamicSort}
                    />
                  </div>
                  <div className="col-span-2">
                    <SortableHeader
                      field="lastRun"
                      label="Last Run"
                      currentSort={dynamicSort}
                      onSort={handleDynamicSort}
                    />
                  </div>
                  <div className="col-span-1">Status</div>
                  <div className="col-span-2" />
                </div>

                {dynamic.map((schedule) => (
                  <div
                    key={schedule.id}
                    className="grid grid-cols-12 items-center gap-4 py-3 text-sm"
                  >
                    <div className="col-span-3 flex min-w-0 items-center gap-2">
                      <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="truncate font-medium">
                          {schedule.task}
                        </div>
                        <div className="truncate font-mono text-xs text-muted-foreground">
                          {schedule.cron} · {schedule.timezone}
                        </div>
                      </div>
                    </div>
                    <div className="col-span-2 truncate font-mono text-xs text-muted-foreground">
                      {schedule.externalId ?? '-'}
                    </div>
                    <div className="col-span-2 text-muted-foreground">
                      {schedule.nextRun ? (
                        <RelativeTime timestamp={schedule.nextRun} />
                      ) : (
                        '-'
                      )}
                    </div>
                    <div className="col-span-2 text-muted-foreground">
                      {schedule.lastRun ? (
                        <RelativeTime timestamp={schedule.lastRun} />
                      ) : (
                        '-'
                      )}
                    </div>
                    <div className="col-span-1">
                      <span
                        className={cn(
                          'inline-flex items-center px-2 py-0.5 text-xs',
                          schedule.active
                            ? 'bg-status-success/10 text-status-success'
                            : 'bg-muted text-muted-foreground',
                        )}
                      >
                        {schedule.active ? 'Active' : 'Paused'}
                      </span>
                    </div>
                    <div className="col-span-2 flex justify-end gap-1">
                      <IconButton
                        label="Run now"
                        onClick={() => {
                          setRunResult(null);
                          setDynamicRunTarget(schedule);
                        }}
                      >
                        <Play className="h-4 w-4" />
                      </IconButton>
                      <IconButton
                        label={schedule.active ? 'Deactivate' : 'Activate'}
                        onClick={() => {
                          if (schedule.active) {
                            deactivateDynamicSchedule.mutate(schedule.id);
                          } else {
                            activateDynamicSchedule.mutate(schedule.id);
                          }
                        }}
                      >
                        {schedule.active ? (
                          <PowerOff className="h-4 w-4" />
                        ) : (
                          <Power className="h-4 w-4" />
                        )}
                      </IconButton>
                      <IconButton
                        label="Delete"
                        onClick={() => setDeleteTarget(schedule)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        ) : null}
      </Tabs>

      <SchedulerDetailSheet
        scheduler={selected}
        onClose={() => setSelected(null)}
        onJobSelect={onJobSelect}
        onRun={(scheduler) => {
          setRunResult(null);
          setRunTarget(scheduler);
        }}
      />

      <Dialog
        open={runTarget !== null}
        onOpenChange={(open) => {
          if (!open) closeRunDialog();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run job now</DialogTitle>
            <DialogDescription>
              {runTarget || dynamicRunTarget ? (
                <>
                  <span className="font-medium text-foreground">
                    {runTarget?.name ?? dynamicRunTarget?.task}
                  </span>{' '}
                  {runTarget ? (
                    <>
                      on queue{' '}
                      <span className="font-mono">{runTarget.queueName}</span>.
                    </>
                  ) : null}{' '}
                  Runs once now; the schedule is unchanged.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          {runResult ? (
            <div
              className={cn(
                'flex items-center gap-2 text-sm',
                runResult.success ? 'text-success' : 'text-destructive',
              )}
            >
              {runResult.success && runTarget ? (
                <>
                  <CheckCircle className="h-4 w-4 shrink-0" />
                  <button
                    type="button"
                    onClick={() => openTriggeredJob(runResult.jobId)}
                    className="cursor-pointer transition-colors hover:text-foreground/80"
                  >
                    Triggered job{' '}
                    <span className="font-mono">{runResult.jobId}</span>
                  </button>
                </>
              ) : runResult.success ? (
                <>
                  <CheckCircle className="h-4 w-4 shrink-0" />
                  Triggered job{' '}
                  <span className="font-mono">{runResult.jobId}</span>
                </>
              ) : (
                <>
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {runResult.message}
                </>
              )}
            </div>
          ) : null}

          <DialogFooter>
            {runResult?.success ? (
              <Button onClick={closeRunDialog}>Close</Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={closeRunDialog}
                  disabled={
                    runScheduler.isPending || runDynamicSchedule.isPending
                  }
                >
                  Cancel
                </Button>
                <Button
                  onClick={confirmRun}
                  disabled={
                    runScheduler.isPending || runDynamicSchedule.isPending
                  }
                >
                  {runScheduler.isPending || runDynamicSchedule.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Running…
                    </>
                  ) : (
                    'Run now'
                  )}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete schedule</DialogTitle>
            <DialogDescription>
              {deleteTarget ? (
                <>
                  Delete <span className="font-mono">{deleteTarget.task}</span>.
                  This removes the stored schedule and its next delayed tick.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!deleteTarget) return;
                deleteDynamicSchedule.mutate(deleteTarget.id, {
                  onSuccess: () => setDeleteTarget(null),
                });
              }}
              disabled={deleteDynamicSchedule.isPending}
            >
              {deleteDynamicSchedule.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Deleting…
                </>
              ) : (
                'Delete'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const CRON_FIELD_LABELS_5 = ['min', 'hour', 'day', 'month', 'wday'];
const CRON_FIELD_LABELS_6 = ['sec', 'min', 'hour', 'day', 'month', 'wday'];

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onClick}
        >
          {children}
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Plain-English translation of a cron pattern ("Every minute"). */
function describeCron(pattern: string): string | null {
  try {
    return cronstrue.toString(pattern, { verbose: false });
  } catch {
    return null;
  }
}

interface SchedulerDetailSheetProps {
  scheduler: SchedulerInfo | null;
  onClose: () => void;
  onJobSelect: (queueName: string, jobId: string) => void;
  onRun: (scheduler: SchedulerInfo) => void;
}

function SchedulerDetailSheet({
  scheduler,
  onClose,
  onJobSelect,
  onRun,
}: SchedulerDetailSheetProps) {
  const {
    data: detail,
    isLoading,
    error,
  } = useSchedulerDetail(scheduler?.queueName, scheduler?.key);
  const [copied, setCopied] = useState(false);

  const copyKey = async () => {
    if (!scheduler) return;
    await navigator.clipboard.writeText(scheduler.key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const description = scheduler?.pattern
    ? describeCron(scheduler.pattern)
    : null;

  return (
    <Sheet
      open={scheduler !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        {scheduler && (
          <>
            <SheetHeader className="shrink-0 space-y-0 border-b px-6 py-4 text-left">
              <div className="flex items-center justify-between gap-3 pr-8">
                <SheetTitle className="flex min-w-0 items-center gap-2 text-base">
                  <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{scheduler.name}</span>
                </SheetTitle>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => onRun(scheduler)}
                >
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                  Run now
                </Button>
              </div>
            </SheetHeader>

            <div className="flex-1 overflow-auto">
              {/* Configuration */}
              <div className="divide-y text-sm">
                <DetailRow icon={Hash} label="Schedule ID" mono>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{scheduler.key}</span>
                    <button
                      type="button"
                      onClick={copyKey}
                      className="shrink-0 rounded p-1 hover:bg-muted"
                    >
                      {copied ? (
                        <Check className="h-3.5 w-3.5 text-status-success" />
                      ) : (
                        <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </button>
                  </span>
                </DetailRow>
                <DetailRow icon={Layers} label="Queue" mono>
                  {scheduler.queueName}
                </DetailRow>
                <DetailRow icon={Repeat} label="Type">
                  <span className="bg-muted px-2 py-0.5 text-xs capitalize">
                    {detail?.type ?? (scheduler.pattern ? 'cron' : 'interval')}
                  </span>
                </DetailRow>
                <DetailRow icon={Globe} label="Timezone">
                  {scheduler.tz || 'UTC'}
                </DetailRow>
                <DetailRow icon={CalendarClock} label="Next run">
                  {scheduler.next ? (
                    <span title={formatAbsoluteTime(scheduler.next)}>
                      <RelativeTime timestamp={scheduler.next} />
                    </span>
                  ) : (
                    '-'
                  )}
                </DetailRow>
                {scheduler.endDate && (
                  <DetailRow icon={CalendarClock} label="Ends">
                    {formatAbsoluteTime(scheduler.endDate)}
                  </DetailRow>
                )}
              </div>

              {/* Schedule expression */}
              <div className="border-t px-6 py-4">
                <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                  {scheduler.pattern ? 'Cron' : 'Interval'}
                </div>
                {scheduler.pattern ? (
                  <CronExpression pattern={scheduler.pattern} />
                ) : (
                  <div className="font-mono text-sm">
                    every {formatDuration(scheduler.every ?? 0)}
                  </div>
                )}
                {description && (
                  <div className="mt-2 text-sm text-muted-foreground">
                    {description}
                  </div>
                )}
              </div>

              {/* Next runs */}
              <div className="border-t px-6 py-4">
                <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                  Next runs
                </div>
                {isLoading && !detail ? (
                  <div className="space-y-2">
                    {[...Array(3)].map((_, i) => (
                      <div
                        key={`up-pulse-${i.toString()}`}
                        className="h-4 w-40 animate-pulse rounded bg-muted"
                      />
                    ))}
                  </div>
                ) : detail && detail.upcoming.length > 0 ? (
                  <div className="space-y-1.5">
                    {detail.upcoming.map((ts) => (
                      <div
                        key={ts}
                        className="flex items-baseline justify-between gap-4 text-sm"
                      >
                        <span className="font-mono tabular-nums">
                          {formatAbsoluteTime(ts)}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          <RelativeTime timestamp={ts} />
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    No upcoming runs
                  </div>
                )}
              </div>

              {/* Recent runs */}
              <div className="border-t px-6 py-4">
                <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                  Recent runs
                </div>
                {error ? (
                  <div className="flex items-center gap-2 text-sm text-status-error">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {error.message}
                  </div>
                ) : isLoading && !detail ? (
                  <div className="space-y-2">
                    {[...Array(3)].map((_, i) => (
                      <div
                        key={`run-pulse-${i.toString()}`}
                        className="h-7 w-full animate-pulse rounded bg-muted"
                      />
                    ))}
                  </div>
                ) : detail && detail.recent.length > 0 ? (
                  <div className="divide-y divide-border/50">
                    {detail.recent.map((run) => (
                      <button
                        key={run.id}
                        type="button"
                        onClick={() => onJobSelect(run.queueName, run.id)}
                        className="flex w-full items-center gap-3 py-2 text-left text-sm transition-colors hover:bg-muted/40"
                      >
                        <StatusBadge status={run.status} />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                          {run.id}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          <RelativeTime
                            timestamp={run.processedOn ?? run.timestamp}
                          />
                        </span>
                        <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums">
                          {run.duration ? formatDuration(run.duration) : '-'}
                        </span>
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    No runs recorded yet
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function CronExpression({ pattern }: { pattern: string }) {
  const parts = pattern.trim().split(/\s+/);
  const labels =
    parts.length === 6
      ? CRON_FIELD_LABELS_6
      : parts.length === 5
        ? CRON_FIELD_LABELS_5
        : parts.map(() => '');

  return (
    <div className="flex flex-wrap gap-1.5">
      {parts.map((part, i) => (
        <div
          key={`${i.toString()}-${part}`}
          className="flex flex-col items-center gap-1"
        >
          <div className="flex h-8 min-w-8 items-center justify-center border bg-muted/40 px-2 font-mono text-sm tabular-nums">
            {part}
          </div>
          {labels[i] && (
            <span className="text-[10px] text-muted-foreground">
              {labels[i]}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function DetailRow({
  icon: Icon,
  label,
  children,
  mono,
}: {
  icon: ElementType;
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-6 py-2.5">
      <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <div className={cn('min-w-0 text-right', mono && 'font-mono text-xs')}>
        {children}
      </div>
    </div>
  );
}
