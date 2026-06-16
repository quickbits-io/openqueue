import type { MouseEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import type { QueueInfo } from '@/core/types';
import { cn } from '@/lib/utils';

interface QueueHealthCardProps {
  queue: QueueInfo;
  sparklineData?: number[];
  onSelect: () => void;
  onFailedClick: (e: MouseEvent) => void;
}

function MiniSparkline({ data }: { data: number[] }) {
  if (data.length === 0) return null;

  const max = Math.max(...data, 1);
  const width = 120;
  const height = 28;
  const points = data.map((value, index) => {
    const x = data.length > 1 ? (index / (data.length - 1)) * width : width / 2;
    const y = height - (value / max) * height;
    return `${x},${y}`;
  });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-7 w-full text-chart-2"
      preserveAspectRatio="none"
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points.join(' ')}
      />
    </svg>
  );
}

export function QueueHealthCard({
  queue,
  sparklineData,
  onSelect,
  onFailedClick,
}: QueueHealthCardProps) {
  const workerLabel =
    queue.workerCount === null || queue.workerCount === undefined
      ? null
      : queue.workerCount === 0
        ? '0 workers'
        : `${queue.workerCount} worker${queue.workerCount === 1 ? '' : 's'}`;

  return (
    <button
      type="button"
      onClick={onSelect}
      className="text-left border bg-card p-4 hover:bg-accent/50 transition-colors min-w-0 flex flex-col gap-3"
    >
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0">
          <span
            className="font-mono font-medium truncate block"
            title={queue.name}
          >
            {queue.name}
          </span>
          {workerLabel && (
            <span
              className={cn(
                'text-[10px] mt-1 block',
                queue.workerCount === 0
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-muted-foreground',
              )}
            >
              {workerLabel}
            </span>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          {queue.isPaused && (
            <Badge
              variant="secondary"
              className="bg-amber-500/10 text-amber-600 text-[10px]"
            >
              Paused
            </Badge>
          )}
        </div>
      </div>

      {sparklineData?.some((v) => v > 0) && (
        <MiniSparkline data={sparklineData} />
      )}

      <div className="grid grid-cols-4 gap-2 text-sm">
        <CountCell label="Waiting" value={queue.counts.waiting} />
        <CountCell
          label="Active"
          value={queue.counts.active}
          className="text-warning"
        />
        <CountCell
          label="Failed"
          value={queue.counts.failed}
          className={queue.counts.failed > 0 ? 'text-destructive' : undefined}
          onClick={queue.counts.failed > 0 ? onFailedClick : undefined}
        />
        <CountCell label="Delayed" value={queue.counts.delayed} />
      </div>
    </button>
  );
}

function CountCell({
  label,
  value,
  className,
  onClick,
}: {
  label: string;
  value: number;
  className?: string;
  onClick?: (e: MouseEvent) => void;
}) {
  const content = (
    <>
      <div className="text-muted-foreground text-[10px] uppercase tracking-wide">
        {label}
      </div>
      <div className={cn('font-medium tabular-nums', className)}>
        {value.toLocaleString()}
      </div>
    </>
  );

  if (onClick) {
    return (
      <div
        role="presentation"
        onClick={(e) => {
          e.stopPropagation();
          onClick(e);
        }}
        className="hover:opacity-80"
      >
        {content}
      </div>
    );
  }

  return <div>{content}</div>;
}

export function metricsBucketsToSparkline(
  buckets: { completed: number; failed: number }[],
): number[] {
  return buckets.map((b) => b.completed + b.failed);
}
