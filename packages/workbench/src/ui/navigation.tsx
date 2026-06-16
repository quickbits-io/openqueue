'use client';

import * as React from 'react';
import { z } from 'zod';

const statuses = [
  'all',
  'active',
  'waiting',
  'waiting-children',
  'prioritized',
  'completed',
  'failed',
  'delayed',
] as const;

const schedulerTabs = ['repeatable', 'delayed', 'dynamic'] as const;
const jobTabs = [
  'payload',
  'output',
  'error',
  'retries',
  'timeline',
  'logs',
] as const;

type Status = (typeof statuses)[number];
type SchedulerTab = (typeof schedulerTabs)[number];
type JobTab = (typeof jobTabs)[number];

export const runsSearchSchema = z.object({
  status: z.enum(statuses).optional().catch('all'),
  q: z.string().optional().catch(''),
  from: z.number().optional(),
  to: z.number().optional(),
  sort: z.string().optional(),
});

export type RunsSearch = z.infer<typeof runsSearchSchema>;

export const queueSearchSchema = z.object({
  status: z.enum(statuses).optional().catch('all'),
  sort: z.string().optional(),
});

export type QueueSearch = z.infer<typeof queueSearchSchema>;

export const schedulersSearchSchema = z.object({
  tab: z.enum(schedulerTabs).optional().catch('repeatable'),
  repeatableSort: z.string().optional(),
  delayedSort: z.string().optional(),
  dynamicSort: z.string().optional(),
});

export type SchedulersSearch = z.infer<typeof schedulersSearchSchema>;

export const jobSearchSchema = z.object({
  tab: z.enum(jobTabs).optional(),
});

export type JobSearch = z.infer<typeof jobSearchSchema>;

export const testSearchSchema = z.object({
  queue: z.string().optional(),
  jobName: z.string().optional(),
  payload: z.string().optional(),
});

export type TestSearch = z.infer<typeof testSearchSchema>;

export type WorkbenchTarget =
  | { name: 'jobs' }
  | { name: 'runs'; search?: RunsSearch }
  | { name: 'errors' }
  | { name: 'metrics' }
  | { name: 'schedulers'; search?: SchedulersSearch }
  | { name: 'flows' }
  | { name: 'flow'; queueName: string; jobId: string }
  | { name: 'queue'; queueName: string; search?: QueueSearch }
  | { name: 'job'; queueName: string; jobId: string; search?: JobSearch }
  | { name: 'test'; search?: TestSearch }
  | { name: 'alerts' };

export type WorkbenchNavigation = {
  href: (target: WorkbenchTarget) => string;
  push: (target: WorkbenchTarget) => void;
  replace: (target: WorkbenchTarget) => void;
};

export const workbenchNavItems = [
  { target: { name: 'runs' }, label: 'Runs' },
  { target: { name: 'errors' }, label: 'Errors' },
  { target: { name: 'metrics' }, label: 'Metrics' },
  { target: { name: 'schedulers' }, label: 'Schedulers' },
  { target: { name: 'flows' }, label: 'Flows' },
  { target: { name: 'alerts' }, label: 'Alerts' },
  { target: { name: 'test' }, label: 'Test' },
] satisfies { target: WorkbenchTarget; label: string }[];

type SearchValue = string | number | boolean | null | undefined;
type SearchRecord = Record<string, SearchValue>;
type SearchParamsLike = Pick<URLSearchParams, 'get'>;

const WorkbenchNavigationContext =
  React.createContext<WorkbenchNavigation | null>(null);

export function WorkbenchNavigationProvider({
  children,
  navigation,
}: {
  children: React.ReactNode;
  navigation: WorkbenchNavigation;
}) {
  return (
    <WorkbenchNavigationContext.Provider value={navigation}>
      {children}
    </WorkbenchNavigationContext.Provider>
  );
}

export function useWorkbenchNavigation() {
  const navigation = React.useContext(WorkbenchNavigationContext);
  if (!navigation) {
    throw new Error(
      'Workbench screens must be rendered inside WorkbenchProvider with navigation.',
    );
  }
  return navigation;
}

export function useOptionalWorkbenchNavigation() {
  return React.useContext(WorkbenchNavigationContext);
}

export function createWorkbenchHref(
  target: WorkbenchTarget,
  options?: { basePath?: string },
) {
  const path = targetPath(target);
  const basePath = normalizeBasePath(options?.basePath ?? '/');
  const pathname =
    basePath === '/' ? path : path === '/' ? basePath : `${basePath}${path}`;
  const params = new URLSearchParams();
  const search = targetSearch(target);

  for (const [key, value] of Object.entries(search ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function parseRunsSearch(params: SearchParamsLike): RunsSearch {
  return {
    status: parseStatus(params.get('status')),
    q: params.get('q') || undefined,
    from: parseNumber(params.get('from')),
    to: parseNumber(params.get('to')),
    sort: params.get('sort') || undefined,
  };
}

export function parseQueueSearch(params: SearchParamsLike): QueueSearch {
  return {
    status: parseStatus(params.get('status')),
    sort: params.get('sort') || undefined,
  };
}

export function parseSchedulersSearch(
  params: SearchParamsLike,
): SchedulersSearch {
  const tab = params.get('tab');

  return {
    tab: isSchedulerTab(tab) ? tab : 'repeatable',
    repeatableSort: params.get('repeatableSort') || undefined,
    delayedSort: params.get('delayedSort') || undefined,
    dynamicSort: params.get('dynamicSort') || undefined,
  };
}

export function parseJobSearch(params: SearchParamsLike): JobSearch {
  const tab = params.get('tab');

  return {
    tab: isJobTab(tab) ? tab : undefined,
  };
}

export function parseTestSearch(params: SearchParamsLike): TestSearch {
  return {
    queue: params.get('queue') || undefined,
    jobName: params.get('jobName') || undefined,
    payload: params.get('payload') || undefined,
  };
}

function targetPath(target: WorkbenchTarget) {
  switch (target.name) {
    case 'jobs':
      return '/';
    case 'runs':
      return '/runs';
    case 'errors':
      return '/errors';
    case 'metrics':
      return '/metrics';
    case 'schedulers':
      return '/schedulers';
    case 'flows':
      return '/flows';
    case 'flow':
      return `/flows/${segment(target.queueName)}/${segment(target.jobId)}`;
    case 'queue':
      return `/queues/${segment(target.queueName)}`;
    case 'job':
      return `/queues/${segment(target.queueName)}/jobs/${segment(target.jobId)}`;
    case 'test':
      return '/test';
    case 'alerts':
      return '/alerts';
  }
}

function targetSearch(target: WorkbenchTarget): SearchRecord | undefined {
  switch (target.name) {
    case 'runs':
    case 'schedulers':
    case 'queue':
    case 'job':
    case 'test':
      return target.search;
    default:
      return undefined;
  }
}

function normalizeBasePath(basePath: string) {
  if (!basePath || basePath === '/') return '/';
  return `/${basePath.replace(/^\/+|\/+$/g, '')}`;
}

function segment(value: string) {
  return encodeURIComponent(value);
}

function parseStatus(value: string | null): Status {
  return statuses.includes(value as Status) ? (value as Status) : 'all';
}

function parseNumber(value: string | null) {
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isSchedulerTab(value: string | null): value is SchedulerTab {
  return schedulerTabs.includes(value as SchedulerTab);
}

function isJobTab(value: string | null): value is JobTab {
  return jobTabs.includes(value as JobTab);
}
