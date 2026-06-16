import type {
  ActivityStatsResponse,
  AlertContactPoint,
  AlertContactPointPublic,
  AlertDeliveryRecord,
  AlertEvent,
  AlertRule,
  AlertRuntimeStatus,
  CreateFlowRequest,
  DelayedJobInfo,
  DynamicScheduleInfo,
  ErrorsResponse,
  FlowNode,
  FlowSummary,
  JobInfo,
  JobLogsResponse,
  JobSpansResponse,
  JobStatus,
  MetricsResponse,
  OverviewStats,
  PaginatedResponse,
  QueueInfo,
  RunInfoList,
  SchedulerDetail,
  SchedulerInfo,
  SearchResult,
  TestJobRequest,
  TestJobResponse,
  WorkbenchRegistryConfig,
} from '@/core/types';
import { apiBase, apiRoot, getConfigUrl, requestHeaders } from './api-base';

// Note: `joinApi` would be nicer per call site, but using a thenable-style
// `toString()` object lets us preserve every existing `${API_BASE}/foo`
// template literal across this file. Template strings call `toString()` on
// objects, so the base is resolved at request time — the desktop host can
// swap connections by mutating `window.__WORKBENCH_RUNTIME__.apiBase`
// between calls without re-importing this module.
const API_BASE = {
  toString() {
    const root = apiRoot();
    if (root) return root;
    const base = apiBase();
    return base ? `${base}/api` : './api';
  },
};

// Default timeout of 60 seconds for API requests
const DEFAULT_TIMEOUT = 60000;

// Extended timeout for heavy operations (120 seconds)
const EXTENDED_TIMEOUT = 120000;

interface FetchOptions extends Omit<RequestInit, 'signal'> {
  timeout?: number;
  signal?: AbortSignal; // React Query's signal for cancellation
}

async function fetchJson<T>(url: string, options?: FetchOptions): Promise<T> {
  const {
    timeout = DEFAULT_TIMEOUT,
    signal: externalSignal,
    ...fetchOptions
  } = options || {};

  // Create AbortController for timeout
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeout);

  // Combine signals: React Query's signal (for unmount) + timeout signal
  // Use AbortSignal.any if available (modern browsers), otherwise just use timeout
  let combinedSignal: AbortSignal;
  if (externalSignal && 'any' in AbortSignal) {
    combinedSignal = AbortSignal.any([
      externalSignal,
      timeoutController.signal,
    ]);
  } else if (externalSignal) {
    // Fallback: link external signal to our controller
    if (externalSignal.aborted) {
      timeoutController.abort();
    } else {
      externalSignal.addEventListener('abort', () => timeoutController.abort());
    }
    combinedSignal = timeoutController.signal;
  } else {
    combinedSignal = timeoutController.signal;
  }

  try {
    const headers = new Headers(await requestHeaders());
    headers.set('Content-Type', 'application/json');
    if (fetchOptions?.headers) {
      new Headers(fetchOptions.headers).forEach((value, key) => {
        headers.set(key, value);
      });
    }

    const response = await fetch(url, {
      ...fetchOptions,
      signal: combinedSignal,
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const apiError = new Error(
        error.error || `HTTP ${response.status}`,
      ) as Error & { issues?: unknown };
      if (Array.isArray(error.issues)) {
        apiError.issues = error.issues;
      }
      throw apiError;
    }

    return response.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      // Check if it was our timeout or external cancellation
      if (externalSignal?.aborted) {
        throw error; // Let React Query handle the cancellation
      }
      throw new Error(`Request timed out after ${timeout / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export const api = {
  /**
   * Clear all server-side caches (for user-initiated refresh)
   */
  async refresh(): Promise<{ success: boolean }> {
    return fetchJson(`${API_BASE}/refresh`, { method: 'POST' });
  },

  /**
   * Get dashboard overview stats (longer timeout as it scans all queues)
   */
  async getOverview(signal?: AbortSignal): Promise<OverviewStats> {
    return fetchJson(`${API_BASE}/overview`, {
      signal,
      timeout: EXTENDED_TIMEOUT,
    });
  },

  /**
   * Get quick job counts for smart polling (lightweight, cached)
   */
  async getCounts(signal?: AbortSignal): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    prioritized: number;
    'waiting-children': number;
    total: number;
    timestamp: number;
  }> {
    return fetchJson(`${API_BASE}/counts`, { signal });
  },

  /**
   * Get just queue names (fast, no counts)
   */
  async getQueueNames(signal?: AbortSignal): Promise<string[]> {
    return fetchJson(`${API_BASE}/queue-names`, { signal });
  },

  /**
   * Get all queues with counts
   */
  async getQueues(signal?: AbortSignal): Promise<QueueInfo[]> {
    return fetchJson(`${API_BASE}/queues`, { signal });
  },

  /**
   * Get 24-hour metrics (longer timeout as it scans all queues)
   */
  async getMetrics(signal?: AbortSignal): Promise<MetricsResponse> {
    return fetchJson(`${API_BASE}/metrics`, {
      signal,
      timeout: EXTENDED_TIMEOUT,
    });
  },

  /**
   * Get error triage groups and 24-hour failure trend.
   */
  async getErrors(signal?: AbortSignal): Promise<ErrorsResponse> {
    return fetchJson(`${API_BASE}/errors`, {
      signal,
      timeout: EXTENDED_TIMEOUT,
    });
  },

  /**
   * Get 7-day activity stats for the timeline (cached server-side)
   */
  async getActivityStats(signal?: AbortSignal): Promise<ActivityStatsResponse> {
    return fetchJson(`${API_BASE}/activity`, {
      signal,
      timeout: EXTENDED_TIMEOUT,
    });
  },

  /**
   * Get jobs for a queue
   */
  async getJobs(
    queueName: string,
    options?: {
      status?: JobStatus;
      limit?: number;
      cursor?: string;
      sort?: string; // format: "field:direction"
    },
  ): Promise<PaginatedResponse<JobInfo>> {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.cursor) params.set('cursor', options.cursor);
    if (options?.sort) params.set('sort', options.sort);

    const query = params.toString();
    return fetchJson(
      `${API_BASE}/queues/${encodeURIComponent(queueName)}/jobs${query ? `?${query}` : ''}`,
    );
  },

  /**
   * Get a single job
   */
  async getJob(queueName: string, jobId: string): Promise<JobInfo> {
    return fetchJson(
      `${API_BASE}/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}`,
    );
  },

  /**
   * Get worker logs written via job.log()
   */
  async getJobLogs(queueName: string, jobId: string): Promise<JobLogsResponse> {
    return fetchJson(
      `${API_BASE}/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}/logs`,
    );
  },

  /**
   * Get persisted spans + logs for a job's run timeline
   */
  async getJobSpans(
    queueName: string,
    jobId: string,
  ): Promise<JobSpansResponse> {
    return fetchJson(
      `${API_BASE}/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}/spans`,
    );
  },

  /**
   * Retry a job
   */
  async retryJob(queueName: string, jobId: string): Promise<void> {
    await fetchJson(
      `${API_BASE}/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}/retry`,
      { method: 'POST' },
    );
  },

  /**
   * Remove a job
   */
  async removeJob(queueName: string, jobId: string): Promise<void> {
    await fetchJson(
      `${API_BASE}/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}/remove`,
      { method: 'POST' },
    );
  },

  /**
   * Promote a delayed job
   */
  async promoteJob(queueName: string, jobId: string): Promise<void> {
    await fetchJson(
      `${API_BASE}/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}/promote`,
      { method: 'POST' },
    );
  },

  /**
   * Get a single scheduler's detail (config, upcoming runs, recent runs)
   */
  async getSchedulerDetail(
    queueName: string,
    schedulerKey: string,
  ): Promise<SchedulerDetail> {
    return fetchJson(
      `${API_BASE}/schedulers/${encodeURIComponent(queueName)}/${encodeURIComponent(schedulerKey)}`,
    );
  },

  /**
   * Trigger an immediate one-off run of a repeatable job scheduler
   */
  async runScheduler(
    queueName: string,
    schedulerKey: string,
  ): Promise<{ id: string }> {
    return fetchJson(
      `${API_BASE}/schedulers/${encodeURIComponent(queueName)}/${encodeURIComponent(schedulerKey)}/run`,
      { method: 'POST' },
    );
  },

  /**
   * Search jobs
   */
  async search(
    query: string,
    limit?: number,
  ): Promise<{ results: SearchResult[] }> {
    const params = new URLSearchParams({ q: query });
    if (limit) params.set('limit', String(limit));
    return fetchJson(`${API_BASE}/search?${params.toString()}`);
  },

  /**
   * Clean jobs from a queue
   */
  async cleanJobs(
    queueName: string,
    status: 'completed' | 'failed',
    grace?: number,
  ): Promise<{ removed: number }> {
    return fetchJson(
      `${API_BASE}/queues/${encodeURIComponent(queueName)}/clean`,
      {
        method: 'POST',
        body: JSON.stringify({ status, grace }),
      },
    );
  },

  /**
   * Get dashboard config
   */
  async getConfig(): Promise<{
    title: string;
    logo?: string;
    readonly: boolean;
    queues: string[];
    tagFields: string[];
    discovery: {
      total: number;
      capped: boolean;
      cap: number;
    } | null;
    alertsEnabled: boolean;
    alertsPersistence: 'redis' | 'memory' | 'custom' | 'postgres' | null;
    capabilities: {
      storage: boolean;
      dynamicSchedules: boolean;
      dynamicScheduleMutations: boolean;
      postgresAlerts: boolean;
      spans: boolean;
    };
    registry: WorkbenchRegistryConfig;
  }> {
    return fetchJson(getConfigUrl());
  },

  /**
   * Get unique values for a tag field
   */
  async getTagValues(
    field: string,
    limit?: number,
  ): Promise<{ field: string; values: { value: string; count: number }[] }> {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    const query = params.toString();
    return fetchJson(
      `${API_BASE}/tags/${encodeURIComponent(field)}/values${query ? `?${query}` : ''}`,
    );
  },

  /**
   * Get all runs (jobs across all queues, longer timeout)
   */
  async getRuns(
    options?: {
      limit?: number;
      cursor?: string;
      sort?: string; // format: "field:direction"
      status?: JobStatus;
      tags?: Record<string, string>;
      text?: string;
      timeRange?: { start: number; end: number };
    },
    signal?: AbortSignal,
  ): Promise<PaginatedResponse<RunInfoList>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.cursor) params.set('cursor', options.cursor);
    if (options?.sort) params.set('sort', options.sort);
    if (options?.status) params.set('status', options.status);
    if (options?.tags && Object.keys(options.tags).length > 0) {
      params.set('tags', JSON.stringify(options.tags));
    }
    if (options?.text) params.set('q', options.text);
    if (options?.timeRange) {
      params.set('from', String(options.timeRange.start));
      params.set('to', String(options.timeRange.end));
    }

    const query = params.toString();
    return fetchJson(`${API_BASE}/runs${query ? `?${query}` : ''}`, {
      signal,
      timeout: EXTENDED_TIMEOUT,
    });
  },

  /**
   * Get schedulers (repeatable and delayed jobs)
   */
  async getSchedulers(options?: {
    repeatableSort?: string; // format: "field:direction"
    delayedSort?: string; // format: "field:direction"
    dynamicSort?: string; // format: "field:direction"
  }): Promise<{
    repeatable: SchedulerInfo[];
    delayed: DelayedJobInfo[];
    dynamic: DynamicScheduleInfo[];
  }> {
    const params = new URLSearchParams();
    if (options?.repeatableSort)
      params.set('repeatableSort', options.repeatableSort);
    if (options?.delayedSort) params.set('delayedSort', options.delayedSort);
    if (options?.dynamicSort) params.set('dynamicSort', options.dynamicSort);

    const query = params.toString();
    return fetchJson(`${API_BASE}/schedulers${query ? `?${query}` : ''}`);
  },

  /**
   * Get repeatable schedulers
   */
  async getRepeatableSchedulers(sort?: string): Promise<SchedulerInfo[]> {
    const { repeatable } = await this.getSchedulers({ repeatableSort: sort });
    return repeatable;
  },

  /**
   * Get delayed schedulers
   */
  async getDelayedSchedulers(sort?: string): Promise<DelayedJobInfo[]> {
    const { delayed } = await this.getSchedulers({ delayedSort: sort });
    return delayed;
  },

  /**
   * Get storage-backed dynamic schedules
   */
  async getDynamicSchedules(sort?: string): Promise<DynamicScheduleInfo[]> {
    const { dynamic } = await this.getSchedulers({ dynamicSort: sort });
    return dynamic;
  },

  async runDynamicSchedule(id: string): Promise<{ id: string }> {
    return fetchJson(`${API_BASE}/schedules/${encodeURIComponent(id)}/run`, {
      method: 'POST',
    });
  },

  async activateDynamicSchedule(id: string): Promise<DynamicScheduleInfo> {
    return fetchJson(
      `${API_BASE}/schedules/${encodeURIComponent(id)}/activate`,
      { method: 'POST' },
    );
  },

  async deactivateDynamicSchedule(id: string): Promise<DynamicScheduleInfo> {
    return fetchJson(
      `${API_BASE}/schedules/${encodeURIComponent(id)}/deactivate`,
      { method: 'POST' },
    );
  },

  async deleteDynamicSchedule(id: string): Promise<{ success: boolean }> {
    return fetchJson(`${API_BASE}/schedules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  /**
   * Enqueue a test job
   */
  async testJob(request: TestJobRequest): Promise<TestJobResponse> {
    return fetchJson(`${API_BASE}/test`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  },

  /**
   * Clean queue jobs by status
   */
  async cleanQueue(
    queueName: string,
    status: JobStatus,
    grace?: number,
  ): Promise<{ removed: number }> {
    return fetchJson(
      `${API_BASE}/queues/${encodeURIComponent(queueName)}/clean`,
      {
        method: 'POST',
        body: JSON.stringify({ status, grace }),
      },
    );
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // Bulk Operations
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Retry multiple jobs
   */
  async bulkRetry(
    jobs: { queueName: string; jobId: string }[],
  ): Promise<{ success: number; failed: number }> {
    return fetchJson(`${API_BASE}/bulk/retry`, {
      method: 'POST',
      body: JSON.stringify({ jobs }),
    });
  },

  /**
   * Delete multiple jobs
   */
  async bulkDelete(
    jobs: { queueName: string; jobId: string }[],
  ): Promise<{ success: number; failed: number }> {
    return fetchJson(`${API_BASE}/bulk/delete`, {
      method: 'POST',
      body: JSON.stringify({ jobs }),
    });
  },

  /**
   * Promote multiple delayed jobs
   */
  async bulkPromote(
    jobs: { queueName: string; jobId: string }[],
  ): Promise<{ success: number; failed: number }> {
    return fetchJson(`${API_BASE}/bulk/promote`, {
      method: 'POST',
      body: JSON.stringify({ jobs }),
    });
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // Queue Control (Pause/Resume)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Pause a queue
   */
  async pauseQueue(
    queueName: string,
  ): Promise<{ success: boolean; paused: boolean }> {
    return fetchJson(
      `${API_BASE}/queues/${encodeURIComponent(queueName)}/pause`,
      { method: 'POST' },
    );
  },

  /**
   * Resume a queue
   */
  async resumeQueue(
    queueName: string,
  ): Promise<{ success: boolean; paused: boolean }> {
    return fetchJson(
      `${API_BASE}/queues/${encodeURIComponent(queueName)}/resume`,
      { method: 'POST' },
    );
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // Flow Operations
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get all flows (longer timeout as it scans all queues)
   */
  async getFlows(
    limit?: number,
    signal?: AbortSignal,
  ): Promise<{ flows: FlowSummary[] }> {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    const query = params.toString();
    return fetchJson(`${API_BASE}/flows${query ? `?${query}` : ''}`, {
      signal,
      timeout: EXTENDED_TIMEOUT,
    });
  },

  /**
   * Get a single flow tree
   */
  async getFlow(queueName: string, jobId: string): Promise<FlowNode> {
    return fetchJson(
      `${API_BASE}/flows/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}`,
    );
  },

  /**
   * Create a new flow
   */
  async createFlow(request: CreateFlowRequest): Promise<{ id: string }> {
    return fetchJson(`${API_BASE}/flows`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // Alerts
  // ─────────────────────────────────────────────────────────────────────────────

  async getAlertStatus(): Promise<AlertRuntimeStatus> {
    return fetchJson(`${API_BASE}/alerts/status`);
  },

  async getAlertContactPoints(): Promise<AlertContactPointPublic[]> {
    return fetchJson(`${API_BASE}/alerts/contact-points`);
  },

  async createAlertContactPoint(
    input: Omit<AlertContactPoint, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<AlertContactPointPublic> {
    return fetchJson(`${API_BASE}/alerts/contact-points`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async updateAlertContactPoint(
    id: string,
    input: Partial<Omit<AlertContactPoint, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<AlertContactPointPublic> {
    return fetchJson(
      `${API_BASE}/alerts/contact-points/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        body: JSON.stringify(input),
      },
    );
  },

  async deleteAlertContactPoint(id: string): Promise<{ success: boolean }> {
    return fetchJson(
      `${API_BASE}/alerts/contact-points/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
  },

  async testAlertContactPoint(id: string): Promise<AlertDeliveryRecord> {
    return fetchJson(
      `${API_BASE}/alerts/contact-points/${encodeURIComponent(id)}/test`,
      { method: 'POST' },
    );
  },

  async getAlertRules(): Promise<AlertRule[]> {
    return fetchJson(`${API_BASE}/alerts/rules`);
  },

  async createAlertRule(
    input: Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<AlertRule> {
    return fetchJson(`${API_BASE}/alerts/rules`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async updateAlertRule(
    id: string,
    input: Partial<Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<AlertRule> {
    return fetchJson(`${API_BASE}/alerts/rules/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },

  async deleteAlertRule(id: string): Promise<{ success: boolean }> {
    return fetchJson(`${API_BASE}/alerts/rules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  async previewAlertRule(id: string): Promise<AlertEvent> {
    return fetchJson(
      `${API_BASE}/alerts/rules/${encodeURIComponent(id)}/preview`,
      { method: 'POST' },
    );
  },
};
