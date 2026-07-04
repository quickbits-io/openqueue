import type { Job } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { withJobLogs } from '../job-logs';

function fakeJob(latencyMs = 0) {
  const lines: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const job = {
    log: async (line: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, latencyMs));
      }
      lines.push(line);
      inFlight--;
      return lines.length;
    },
  } as unknown as Job;

  return { job, lines, maxInFlight: () => maxInFlight };
}

describe('withJobLogs', () => {
  it('streams lines as they are emitted, not at run end', async () => {
    const { job, lines } = fakeJob();

    await withJobLogs(job, async () => {
      console.log('first');
      // Let the write chain advance before the job "keeps working".
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(lines).toEqual(['first']);
      console.log('second');
    });

    expect(lines).toEqual(['first', 'second']);
  });

  it('preserves emit order and drains fully before returning', async () => {
    const { job, lines } = fakeJob(1);
    const emitted = Array.from({ length: 50 }, (_, i) => `line ${i}`);

    await withJobLogs(job, async () => {
      for (const line of emitted) console.log(line);
    });

    expect(lines).toEqual(emitted);
  });

  it('writes serially — one in-flight log write at a time', async () => {
    const { job, maxInFlight } = fakeJob(1);

    await withJobLogs(job, async () => {
      for (let i = 0; i < 20; i++) console.log(`line ${i}`);
    });

    expect(maxInFlight()).toBe(1);
  });

  it('survives log write failures without breaking the run or later writes', async () => {
    const lines: string[] = [];
    let calls = 0;
    const job = {
      log: async (line: string) => {
        calls++;
        if (calls === 1) throw new Error('redis hiccup');
        lines.push(line);
        return lines.length;
      },
    } as unknown as Job;

    const result = await withJobLogs(job, async () => {
      console.log('lost');
      console.log('kept');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(lines).toEqual(['kept']);
  });
});
