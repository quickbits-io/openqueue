import { AsyncLocalStorage } from 'node:async_hooks';
import { format } from 'node:util';
import { trace } from '@opentelemetry/api';
import type { Job } from 'bullmq';

const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;

type ConsoleMethod = (typeof consoleMethods)[number];

interface JobLogScope {
  write(line: string): void;
}

const activeScope = new AsyncLocalStorage<JobLogScope>();
const originalConsole: Record<ConsoleMethod, (...args: unknown[]) => void> = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};
let consoleBridgeInstalled = false;

export async function withJobLogs<T>(
  job: Job,
  fn: () => Promise<T>,
): Promise<T> {
  installConsoleBridge();

  const pending: Promise<unknown>[] = [];
  let closed = false;
  const scope: JobLogScope = {
    write: (line) => {
      if (closed) return;
      pending.push(job.log(line).catch(() => undefined));
    },
  };

  try {
    return await activeScope.run(scope, fn);
  } finally {
    closed = true;
    await flush(pending);
  }
}

function installConsoleBridge(): void {
  if (consoleBridgeInstalled) return;
  consoleBridgeInstalled = true;

  for (const method of consoleMethods) {
    console[method] = (...args: unknown[]) => {
      originalConsole[method](...args);
      const scope = activeScope.getStore();
      if (!scope) return;
      const line = format(...args);
      scope.write(line);
      trace.getActiveSpan()?.addEvent(line, { 'log.level': method });
    };
  }
}

async function flush(pending: Promise<unknown>[]): Promise<void> {
  if (pending.length === 0) return;
  await Promise.allSettled(pending);
}
