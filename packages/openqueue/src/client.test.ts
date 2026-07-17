import { task, unbindQueueRuntime } from '@openqueue/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createClient } from './client';

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

afterEach(() => {
  unbindQueueRuntime();
});

describe('sdk createClient binding', () => {
  it('binds the http client so task().trigger() goes over HTTP', async () => {
    const calls: Recorded[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      calls.push({
        url: typeof input === 'string' ? input : input.toString(),
        method: init?.method ?? 'GET',
        body: init?.body != null ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(
        JSON.stringify({
          id: 'r1',
          runId: 'r1',
          jobId: 'j1',
          transportJobId: 'j1',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    };

    createClient({ host: 'http://worker.test', fetch });

    const sendEmail = task({
      id: 'send-email',
      queue: 'default',
      run: async (input: { to: string }) => input,
    });

    const result = await sendEmail.trigger({ to: 'a@b.com' });

    expect(result).toMatchObject({ runId: 'r1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('http://worker.test/openqueue/v1/jobs');
    expect(calls[0]?.body).toMatchObject({
      task: 'send-email',
      input: { to: 'a@b.com' },
    });
  });
});
