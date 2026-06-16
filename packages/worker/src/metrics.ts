const statuses = [
  'waiting',
  'prioritized',
  'active',
  'delayed',
  'failed',
] as const;

type QueueStatus = (typeof statuses)[number];

export interface QueueCounts {
  waiting: number;
  prioritized: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface QueueMetricSnapshot {
  queue: string;
  counts: QueueCounts;
}

export interface QueueMetricReader {
  name: string;
  getJobCounts: (
    ...statuses: QueueStatus[]
  ) => Promise<Partial<Record<QueueStatus, number>>>;
}

export function createQueueMetrics(
  queues: QueueMetricReader[],
  metricPrefix = 'openqueue_worker',
): () => Promise<string> {
  return async () => {
    const snapshots = await Promise.all(queues.map(readQueueMetrics));
    return formatQueueMetrics(snapshots, metricPrefix);
  };
}

export async function readQueueMetrics(
  queue: QueueMetricReader,
): Promise<QueueMetricSnapshot> {
  const counts = await queue.getJobCounts(...statuses);
  return {
    queue: queue.name,
    counts: {
      waiting: counts.waiting ?? 0,
      prioritized: counts.prioritized ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
    },
  };
}

export function formatQueueMetrics(
  snapshots: QueueMetricSnapshot[],
  metricPrefix = 'openqueue_worker',
): string {
  let scaleDepth = 0;
  const jobsMetric = `${metricPrefix}_queue_jobs`;
  const depthMetric = `${metricPrefix}_queue_scale_depth`;
  const lines = [
    `# HELP ${jobsMetric} BullMQ jobs by queue and status.`,
    `# TYPE ${jobsMetric} gauge`,
  ];

  for (const snapshot of snapshots) {
    scaleDepth += snapshot.counts.waiting + snapshot.counts.prioritized;
    for (const status of statuses) {
      lines.push(
        `${jobsMetric}{queue="${label(snapshot.queue)}",status="${status}"} ${snapshot.counts[status]}`,
      );
    }
  }

  lines.push(
    `# HELP ${depthMetric} Waiting and prioritized jobs across all worker queues.`,
    `# TYPE ${depthMetric} gauge`,
    `${depthMetric} ${scaleDepth}`,
  );

  return `${lines.join('\n')}\n`;
}

function label(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('"', '\\"');
}
