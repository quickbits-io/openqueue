import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle,
  ChevronDown,
  FlaskConical,
  GitBranch,
  Play,
  Workflow,
} from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type {
  TestJobRequest,
  TestJobResponse,
  WorkbenchRegistryConfig,
  WorkbenchRegistryFlow,
  WorkbenchRegistryJob,
} from '@/core/types';
import { useTestJob } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import type { TestSearch } from '@/navigation';

type RegistryEntry = WorkbenchRegistryJob | WorkbenchRegistryFlow;

interface ValidationIssue {
  path: string;
  message: string;
}

interface TestPageProps {
  registry?: WorkbenchRegistryConfig;
  readonly?: boolean;
  prefill?: TestSearch;
  onJobSelect?: (queueName: string, jobId: string) => void;
  onFlowSelect?: (queueName: string, jobId: string) => void;
}

type EnqueueResult =
  | { status: 'success'; run: TestJobResponse }
  | { status: 'error'; message: string };

function entryKey(entry: RegistryEntry): string {
  return `${entry.type}:${entry.id}`;
}

function formatPayload(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function getErrorIssues(error: Error): ValidationIssue[] {
  const issues = (error as Error & { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];

  return issues.map((issue) => {
    const entry = issue as { path?: unknown; message?: unknown };
    return {
      path: typeof entry.path === 'string' ? entry.path : '',
      message:
        typeof entry.message === 'string' ? entry.message : 'Invalid value',
    };
  });
}

function EnqueuedRunCard({
  run,
  onOpen,
}: {
  run: TestJobResponse;
  onOpen?: (queueName: string, jobId: string) => void;
}) {
  const label = run.type === 'flow' ? 'Flow' : 'Job';
  const content = (
    <>
      <CheckCircle className="h-4 w-4 shrink-0 text-status-success" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label} enqueued</div>
        <div className="truncate text-xs text-muted-foreground">
          {run.name} · {run.queueName} ·{' '}
          <span className="font-mono">{run.id}</span>
        </div>
      </div>
    </>
  );

  if (!onOpen) {
    return (
      <div className="flex items-center gap-3 border border-status-success/40 bg-status-success/5 p-3">
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpen(run.queueName, run.jobId)}
      className="flex w-full items-center gap-3 border border-status-success/40 bg-status-success/5 p-3 text-left hover:bg-status-success/10 focus:outline-none"
    >
      {content}
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        View {label.toLowerCase()}
        <ArrowRight className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}

export function TestPage({
  registry,
  readonly,
  prefill,
  onJobSelect,
  onFlowSelect,
}: TestPageProps) {
  const testJobMutation = useTestJob();
  const entries = React.useMemo<RegistryEntry[]>(
    () => [...(registry?.jobs ?? []), ...(registry?.flows ?? [])],
    [registry],
  );
  const jobs = registry?.jobs ?? [];
  const flows = registry?.flows ?? [];
  const prefillQueue = prefill?.queue;
  const prefillJobName = prefill?.jobName;
  const prefillPayload = prefill?.payload;
  const [selectedKey, setSelectedKey] = React.useState('');
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const selectedEntry = entries.find(
    (entry) => entryKey(entry) === selectedKey,
  );
  const [payload, setPayload] = React.useState('');
  const [delay, setDelay] = React.useState('');
  const [issues, setIssues] = React.useState<ValidationIssue[]>([]);
  const [result, setResult] = React.useState<EnqueueResult | null>(null);

  React.useEffect(() => {
    const cloned =
      registry && prefillQueue && prefillJobName
        ? registry.jobs.find(
            (job) => job.queue === prefillQueue && job.name === prefillJobName,
          )
        : undefined;
    const next = cloned ?? entries[0];

    if (!next) {
      setSelectedKey('');
      setPayload('');
      return;
    }

    setSelectedKey(entryKey(next));
    setPayload(cloned && prefillPayload ? prefillPayload : formatPayload({}));
    setIssues([]);
    setResult(null);
  }, [entries, prefillJobName, prefillPayload, prefillQueue, registry]);

  const setSelectedEntry = React.useCallback(
    (key: string) => {
      const next = entries.find((entry) => entryKey(entry) === key);
      if (!next) return;
      setSelectedKey(key);
      setPayload(formatPayload({}));
      setIssues([]);
      setResult(null);
    },
    [entries],
  );

  const submitJob = React.useCallback(() => {
    if (!selectedEntry) {
      setResult({ status: 'error', message: 'Select a job or flow' });
      return;
    }

    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(payload);
    } catch {
      setIssues([]);
      setResult({ status: 'error', message: 'Invalid JSON payload' });
      return;
    }

    const delaySeconds = delay ? Number(delay) : undefined;
    if (
      delaySeconds !== undefined &&
      (!Number.isFinite(delaySeconds) || delaySeconds < 0)
    ) {
      setIssues([]);
      setResult({ status: 'error', message: 'Delay must be zero or greater' });
      return;
    }
    const delayMs =
      delaySeconds !== undefined ? delaySeconds * 1000 : undefined;

    const request: TestJobRequest = {
      type: selectedEntry.type,
      id: selectedEntry.id,
      data: parsedPayload,
      opts: delayMs !== undefined ? { delay: delayMs } : undefined,
    };

    setIssues([]);
    setResult(null);

    testJobMutation.mutate(request, {
      onSuccess: (response) => {
        setResult({ status: 'success', run: response });
      },
      onError: (error) => {
        setIssues(getErrorIssues(error));
        setResult({ status: 'error', message: error.message });
      },
    });
  }, [delay, payload, selectedEntry, testJobMutation]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitJob();
  };

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        submitJob();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [submitJob]);

  if (readonly) {
    return (
      <div className="flex h-[400px] flex-col items-center justify-center text-center">
        <FlaskConical className="mb-4 h-12 w-12 text-muted-foreground" />
        <h2 className="mb-2 text-lg font-medium">Test Mode Disabled</h2>
        <p className="max-w-md text-muted-foreground">
          The dashboard is in readonly mode. Job testing is disabled.
        </p>
      </div>
    );
  }

  if (!entries.length) {
    return (
      <div className="flex h-[400px] flex-col items-center justify-center text-center">
        <FlaskConical className="mb-4 h-12 w-12 text-muted-foreground" />
        <h2 className="mb-2 text-lg font-medium">No Registered Jobs</h2>
        <p className="max-w-md text-muted-foreground">
          Workbench did not receive a job registry from the host application.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl">
      <form
        onSubmit={handleSubmit}
        className="grid gap-6 lg:grid-cols-[320px_1fr]"
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="test-target" className="text-sm font-medium">
              Target
            </label>
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  id="test-target"
                  role="combobox"
                  aria-expanded={pickerOpen}
                  className="flex h-9 w-full items-center justify-between gap-2 whitespace-nowrap border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus:outline-none"
                >
                  {selectedEntry ? (
                    <span className="flex min-w-0 items-center gap-2">
                      {selectedEntry.type === 'flow' ? (
                        <Workflow className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <Play className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <span className="truncate">{selectedEntry.name}</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      Select a job or flow
                    </span>
                  )}
                  <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-[var(--radix-popover-trigger-width)] p-0"
              >
                <Command>
                  <CommandInput placeholder="Search jobs and flows..." />
                  <CommandList>
                    <CommandEmpty>No jobs or flows found.</CommandEmpty>
                    {jobs.length > 0 && (
                      <CommandGroup heading="Jobs">
                        {jobs.map((job) => (
                          <CommandItem
                            key={entryKey(job)}
                            value={entryKey(job)}
                            keywords={[job.name, job.queue]}
                            onSelect={(value) => {
                              setSelectedEntry(value);
                              setPickerOpen(false);
                            }}
                          >
                            <Play />
                            <span className="truncate">{job.name}</span>
                            {entryKey(job) === selectedKey && (
                              <Check className="ml-auto" />
                            )}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                    {jobs.length > 0 && flows.length > 0 && (
                      <CommandSeparator />
                    )}
                    {flows.length > 0 && (
                      <CommandGroup heading="Flows">
                        {flows.map((flow) => (
                          <CommandItem
                            key={entryKey(flow)}
                            value={entryKey(flow)}
                            keywords={[flow.name, flow.queue]}
                            onSelect={(value) => {
                              setSelectedEntry(value);
                              setPickerOpen(false);
                            }}
                          >
                            <Workflow />
                            <span className="truncate">{flow.name}</span>
                            {entryKey(flow) === selectedKey && (
                              <Check className="ml-auto" />
                            )}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          {selectedEntry && (
            <div className="space-y-3 border bg-muted/20 p-3">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center border bg-background">
                  {selectedEntry.type === 'flow' ? (
                    <GitBranch className="h-4 w-4" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {selectedEntry.name}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {selectedEntry.queue}
                  </div>
                </div>
              </div>

              {selectedEntry.description && (
                <p className="text-sm text-muted-foreground">
                  {selectedEntry.description}
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                <span className="border bg-background px-2 py-1 text-xs capitalize">
                  {selectedEntry.type}
                </span>
                {'attempts' in selectedEntry && (
                  <span className="border bg-background px-2 py-1 text-xs">
                    Attempts {selectedEntry.attempts}
                  </span>
                )}
                {'cron' in selectedEntry && selectedEntry.cron && (
                  <span className="border bg-background px-2 py-1 text-xs">
                    {selectedEntry.cron}
                  </span>
                )}
                {selectedEntry.tags.map((tag) => (
                  <span
                    key={tag}
                    className="border bg-background px-2 py-1 text-xs"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <label htmlFor="delay" className="text-sm font-medium">
              Delay (seconds)
            </label>
            <input
              id="delay"
              type="number"
              value={delay}
              onChange={(e) => setDelay(e.target.value)}
              className="h-9 w-full border bg-background px-3 text-sm focus:outline-none"
              placeholder="0"
              min="0"
            />
          </div>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="payload" className="text-sm font-medium">
              Body (JSON)
            </label>
            <textarea
              id="payload"
              value={payload}
              onChange={(e) => {
                setPayload(e.target.value);
                setIssues([]);
                setResult(null);
              }}
              className={cn(
                'h-[420px] w-full resize-none border bg-background px-3 py-2 font-mono text-sm leading-6 focus:outline-none',
                issues.length > 0 && 'border-destructive',
              )}
              placeholder='{ "key": "value" }'
              spellCheck={false}
            />
          </div>

          {issues.length > 0 && (
            <div className="space-y-1 border border-destructive/40 bg-destructive/5 p-3">
              {issues.map((issue) => (
                <div
                  key={`${issue.path}:${issue.message}`}
                  className="text-sm text-destructive"
                >
                  {issue.path
                    ? `${issue.path}: ${issue.message}`
                    : issue.message}
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit" disabled={testJobMutation.isPending}>
              {testJobMutation.isPending ? 'Processing...' : 'Enqueue'}
            </Button>

            {result?.status === 'error' && (
              <div className="flex min-w-0 items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span className="break-all">{result.message}</span>
              </div>
            )}
          </div>

          {result?.status === 'success' && (
            <EnqueuedRunCard
              run={result.run}
              onOpen={result.run.type === 'flow' ? onFlowSelect : onJobSelect}
            />
          )}
        </div>
      </form>
    </div>
  );
}
