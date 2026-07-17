import type { QueueDrain, QueueRunSnapshot, SerializedError } from './types';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GRAY = '\x1b[90m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

export interface ConsoleDrainOptions {
  color?: boolean;
  includeInput?: boolean;
}

export function consoleDrain(opts: ConsoleDrainOptions = {}): QueueDrain {
  const color = opts.color ?? process.stdout.isTTY;

  return {
    name: 'console',
    handle: async (event) => {
      const run = event.run;

      if (event.type === 'enqueue') {
        const suffix = opts.includeInput
          ? ` ${DIM}${JSON.stringify(run.input).slice(0, 200)}${RESET}`
          : '';
        console.log(
          `${tag(color, 'QUEUED', CYAN)} ${prefix(run, color)}${suffix}`,
        );
        return;
      }

      if (event.type === 'start') {
        const attemptBadge =
          run.attempt > 1
            ? ` ${YELLOW}retry ${run.attempt}/${run.maxAttempts}${RESET}`
            : '';
        console.log(
          `${tag(color, 'START ', YELLOW)} ${prefix(run, color)}${attemptBadge}`,
        );
        return;
      }

      if (event.type === 'complete') {
        console.log(
          `${tag(color, 'DONE  ', GREEN)} ${prefix(run, color)} ${GRAY}${formatDuration(run.durationMs)}${RESET}`,
        );
        return;
      }

      if (event.type === 'cancel') {
        console.log(
          `${tag(color, 'CANCEL', GRAY)} ${prefix(run, color)} ${GRAY}canceled${RESET}`,
        );
        return;
      }

      if (event.type === 'fail') {
        const verdict = run.willRetry
          ? `${YELLOW}will retry (${run.attempt}/${run.maxAttempts})${RESET}`
          : `${RED}terminal${RESET}`;
        console.error(
          `${tag(color, 'FAIL  ', RED)} ${prefix(run, color)} ${GRAY}${formatDuration(run.durationMs)}${RESET} ${verdict}\n    ${RED}${formatError(run.error)}${RESET}`,
        );
      }
    },
  };
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  return `${(s / 60).toFixed(2)}m`;
}

function tag(color: boolean, label: string, fg: string, bg?: string): string {
  if (!color) return `[${label}]`;
  return `${bg ?? ''}${fg}${BOLD} ${label} ${RESET}`;
}

function prefix(run: QueueRunSnapshot, color: boolean): string {
  const id = run.id.slice(0, 8);
  if (!color) return `${run.name} ${id}`;
  return `${BOLD}${run.name}${RESET} ${DIM}${id}${RESET}`;
}

function formatError(err: SerializedError | undefined): string {
  if (!err) return 'unknown error';
  return err.stack
    ? `${err.name}: ${err.message}\n${err.stack
        .split('\n')
        .slice(1, 4)
        .map((line) => `    ${line.trim()}`)
        .join('\n')}`
    : `${err.name}: ${err.message}`;
}
