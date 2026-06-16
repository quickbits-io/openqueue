import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import type { QueueInfo } from '@/core/types';

export interface AttentionAlert {
  id: string;
  variant: 'destructive' | 'warning' | 'default';
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface AttentionAlertsProps {
  queues: QueueInfo[];
  onQueueSelect: (queue: string) => void;
  onViewFailed: (queue: string) => void;
}

export function buildAttentionAlerts(
  queues: QueueInfo[],
  onQueueSelect: (queue: string) => void,
  onViewFailed: (queue: string) => void,
): AttentionAlert[] {
  const alerts: AttentionAlert[] = [];

  for (const queue of queues) {
    const backlog =
      queue.counts.waiting +
      queue.counts.prioritized +
      queue.counts['waiting-children'];

    if (
      queue.workerCount === 0 &&
      backlog > 0 &&
      queue.workerCount !== null &&
      queue.workerCount !== undefined
    ) {
      alerts.push({
        id: `workers-${queue.name}`,
        variant: 'destructive',
        title: `${queue.name}: no workers connected`,
        description: `${backlog.toLocaleString()} jobs waiting with zero workers processing this queue.`,
        actionLabel: 'Open queue',
        onAction: () => onQueueSelect(queue.name),
      });
    }

    if (queue.isPaused) {
      alerts.push({
        id: `paused-${queue.name}`,
        variant: 'warning',
        title: `${queue.name} is paused`,
        description:
          'New jobs will not be processed until the queue is resumed.',
        actionLabel: 'Open queue',
        onAction: () => onQueueSelect(queue.name),
      });
    }

    if (queue.counts.failed > 0) {
      alerts.push({
        id: `failed-${queue.name}`,
        variant: 'warning',
        title: `${queue.counts.failed.toLocaleString()} failed jobs in ${queue.name}`,
        description: 'Review failures and retry or remove stale jobs.',
        actionLabel: 'View failed',
        onAction: () => onViewFailed(queue.name),
      });
    }
  }

  return alerts;
}

function AlertItem({ alert }: { alert: AttentionAlert }) {
  const Icon =
    alert.variant === 'destructive'
      ? AlertCircle
      : alert.variant === 'warning'
        ? AlertTriangle
        : CheckCircle2;

  return (
    <Alert
      variant={alert.variant}
      className="px-3 py-2.5 [&>svg]:left-3 [&>svg]:top-3 [&>svg~*]:pl-6"
    >
      <Icon className="size-3.5" />
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <AlertTitle className="mb-0 text-sm font-medium leading-snug">
            {alert.title}
          </AlertTitle>
          <AlertDescription className="text-[11px] leading-relaxed">
            {alert.description}
          </AlertDescription>
        </div>
        {alert.actionLabel && alert.onAction && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 self-start px-2.5 text-xs sm:self-center"
            onClick={alert.onAction}
          >
            {alert.actionLabel}
          </Button>
        )}
      </div>
    </Alert>
  );
}

export function AttentionAlerts({
  queues,
  onQueueSelect,
  onViewFailed,
}: AttentionAlertsProps) {
  const alerts = buildAttentionAlerts(queues, onQueueSelect, onViewFailed);

  if (alerts.length === 0) {
    return (
      <Alert
        variant="default"
        className="px-3 py-2.5 [&>svg]:left-3 [&>svg]:top-3 [&>svg~*]:pl-6"
      >
        <CheckCircle2 className="size-3.5" />
        <div className="min-w-0 space-y-0.5">
          <AlertTitle className="mb-0 text-sm font-medium leading-snug">
            No issues detected
          </AlertTitle>
          <AlertDescription className="text-[11px] leading-relaxed">
            All queues look healthy. Metrics refresh every few seconds while the
            dashboard is open.
          </AlertDescription>
        </div>
      </Alert>
    );
  }

  const visible = alerts.slice(0, 3);
  const hidden = alerts.slice(3);

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Needs attention
      </h3>
      {visible.map((alert) => (
        <AlertItem key={alert.id} alert={alert} />
      ))}
      {hidden.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1 px-2 text-xs text-muted-foreground"
            >
              <ChevronDown className="h-3.5 w-3.5" />
              Show {hidden.length} more
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-3">
            {hidden.map((alert) => (
              <AlertItem key={alert.id} alert={alert} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
