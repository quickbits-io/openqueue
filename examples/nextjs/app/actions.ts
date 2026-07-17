'use server';

import { redirect } from 'next/navigation';
import { openqueue } from '../lib/client';

export async function dispatchExample(formData: FormData): Promise<void> {
  const message = String(formData.get('message') ?? 'Hello from Next.js');
  const { runId } = await openqueue.trigger('example', { message });
  redirect(`/runs/${runId}`);
}
