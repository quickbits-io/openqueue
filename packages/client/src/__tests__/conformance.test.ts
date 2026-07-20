import type { EnqueueResult, QueueRun, QueueSchedule } from '@openqueue/core';
import type { ControlRuntime } from '@openqueue/core/control';
import { expect, it } from 'vitest';
import { createClient } from '../client';
import type * as local from '../types';

type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

const runParity: MutuallyAssignable<QueueRun, local.QueueRun> = true;
const scheduleParity: MutuallyAssignable<QueueSchedule, local.QueueSchedule> =
  true;
const enqueueParity: MutuallyAssignable<EnqueueResult, local.EnqueueResult> =
  true;

it('satisfies the core ControlRuntime contract', () => {
  const client: ControlRuntime = createClient({ host: 'http://x' });
  expect(client && runParity && scheduleParity && enqueueParity).toBeTruthy();
});
