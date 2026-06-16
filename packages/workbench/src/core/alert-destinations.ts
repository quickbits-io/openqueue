import type { AlertContactPoint, AlertEvent } from './types';

/** Default Workbench notification identity */
export const DEFAULT_ALERT_SENDER_NAME = 'Workbench Alerts';

/** Inline SVG data URI for Workbench app icon (used as Slack avatar when supported) */
export const DEFAULT_WORKBENCH_ICON_URL =
  'https://raw.githubusercontent.com/pontusab/workbench/main/packages/core/src/ui/public/app-icon.svg';

/** Slack incoming webhook URLs (modern app or legacy custom integration). */
export function isSlackIncomingWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'hooks.slack.com' ||
        parsed.hostname === 'hooks.slack-gov.com') &&
      parsed.pathname.startsWith('/services/')
    );
  } catch {
    return false;
  }
}

const DISCORD_WEBHOOK_HOSTS = new Set([
  'discord.com',
  'discordapp.com',
  'canary.discord.com',
  'ptb.discord.com',
]);

/** Discord channel webhook URLs (https://discord.com/api/webhooks/:id/:token). */
export function isDiscordWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      DISCORD_WEBHOOK_HOSTS.has(parsed.hostname) &&
      parsed.pathname.startsWith('/api/webhooks/')
    );
  } catch {
    return false;
  }
}

export function validateContactPointUrl(
  preset: AlertContactPoint['preset'],
  url: string,
): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return 'URL must use http or https';
    }
  } catch {
    return 'Invalid URL';
  }

  if (preset === 'slack' && !isSlackIncomingWebhookUrl(url)) {
    return 'Slack contact points require an incoming webhook URL (https://hooks.slack.com/services/...)';
  }

  if (preset === 'discord' && !isDiscordWebhookUrl(url)) {
    return 'Discord contact points require a webhook URL (https://discord.com/api/webhooks/...)';
  }

  return undefined;
}

const SLACK_HEADER_MAX = 150;

const SEVERITY_EMOJI: Record<string, string> = {
  critical: '🔴',
  warning: '🟡',
  info: '🔵',
};

const DISCORD_NEUTRAL_COLOR = 0x6b7280;

const SEVERITY_COLOR: Record<string, number> = {
  critical: 0xef4444,
  warning: 0xf59e0b,
  info: 0x3b82f6,
};

const DISCORD_FIELD_MAX = 1024;

function severityLabel(severity: string): string {
  return severity.charAt(0).toUpperCase() + severity.slice(1);
}

function buildDashboardLink(
  dashboardUrl: string | undefined,
  event: AlertEvent,
): string | undefined {
  if (!dashboardUrl) return undefined;
  const base = dashboardUrl.replace(/\/$/, '');
  if (event.queue && event.jobId) {
    return `${base}/queues/${encodeURIComponent(event.queue)}/jobs/${encodeURIComponent(event.jobId)}`;
  }
  if (event.queue) {
    return `${base}/queues/${encodeURIComponent(event.queue)}?status=failed`;
  }
  return `${base}/`;
}

export interface FormattedDestinationPayload {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export function formatSlackPayload(
  contactPoint: AlertContactPoint,
  event: AlertEvent,
  dashboardUrl?: string,
): FormattedDestinationPayload {
  const emoji = SEVERITY_EMOJI[event.severity] ?? '⚪';
  const link = buildDashboardLink(dashboardUrl, event);
  const senderName = contactPoint.displayName ?? DEFAULT_ALERT_SENDER_NAME;
  const iconUrl = contactPoint.iconUrl ?? DEFAULT_WORKBENCH_ICON_URL;

  const fields: Array<{ type: string; text: string }> = [];
  if (event.queue) {
    fields.push({ type: 'mrkdwn', text: `*Queue:*\n${event.queue}` });
  }
  if (event.jobName || event.jobId) {
    fields.push({
      type: 'mrkdwn',
      text: `*Job:*\n${event.jobName ?? '—'} (\`${event.jobId ?? '—'}\`)`,
    });
  }
  if (event.failedReason) {
    fields.push({
      type: 'mrkdwn',
      text: `*Reason:*\n${event.failedReason.slice(0, 500)}`,
    });
  }
  if (event.counts) {
    const parts: string[] = [];
    if (event.counts.failed !== undefined) {
      parts.push(`Failed: ${event.counts.failed}`);
    }
    if (event.counts.backlog !== undefined) {
      parts.push(`Backlog: ${event.counts.backlog}`);
    }
    if (event.counts.workers !== undefined && event.counts.workers !== null) {
      parts.push(`Workers: ${event.counts.workers}`);
    }
    if (parts.length > 0) {
      fields.push({ type: 'mrkdwn', text: `*Counts:*\n${parts.join(' · ')}` });
    }
  }

  const blocks: unknown[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} ${event.ruleName}`.slice(0, SLACK_HEADER_MAX),
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${severityLabel(event.severity)}* · \`${event.trigger}\`\n${event.message}`,
      },
    },
  ];

  if (fields.length > 0) {
    blocks.push({
      type: 'section',
      fields: fields.slice(0, 10),
    });
  }

  if (link?.startsWith('https://')) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open in Workbench', emoji: true },
          url: link,
        },
      ],
    });
  } else if (link) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `<${link}|Open in Workbench>` }],
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: event.status === 'resolved' ? '✅ Resolved' : '🔔 Firing',
      },
    ],
  });

  const body: Record<string, unknown> = {
    username: senderName,
    icon_url: iconUrl,
    blocks,
    text: `${emoji} ${event.ruleName}: ${event.message}`,
  };

  return {
    url: contactPoint.url,
    headers: { 'Content-Type': 'application/json' },
    body,
  };
}

export function formatWebhookPayload(
  contactPoint: AlertContactPoint,
  event: AlertEvent,
  dashboardUrl?: string,
): FormattedDestinationPayload {
  const link = buildDashboardLink(dashboardUrl, event);
  const body = {
    source: 'workbench',
    version: 1,
    contactPoint: { id: contactPoint.id, name: contactPoint.name },
    event: {
      id: event.id,
      ruleId: event.ruleId,
      ruleName: event.ruleName,
      trigger: event.trigger,
      severity: event.severity,
      status: event.status,
      fingerprint: event.fingerprint,
      message: event.message,
      queue: event.queue,
      jobId: event.jobId,
      jobName: event.jobName,
      failedReason: event.failedReason,
      attemptsMade: event.attemptsMade,
      counts: event.counts,
      firedAt: event.firedAt,
      resolvedAt: event.resolvedAt,
      dashboardUrl: link,
    },
  };

  return {
    url: contactPoint.url,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Workbench-Alerts/1.0',
      ...contactPoint.headers,
    },
    body,
  };
}

export function formatDiscordPayload(
  contactPoint: AlertContactPoint,
  event: AlertEvent,
  dashboardUrl?: string,
): FormattedDestinationPayload {
  const emoji = SEVERITY_EMOJI[event.severity] ?? '⚪';
  const link = buildDashboardLink(dashboardUrl, event);
  const senderName = contactPoint.displayName ?? DEFAULT_ALERT_SENDER_NAME;
  const iconUrl = contactPoint.iconUrl ?? DEFAULT_WORKBENCH_ICON_URL;

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  const pushField = (name: string, value: string, inline = true) => {
    const trimmed = value.trim();
    if (trimmed) {
      fields.push({ name, value: trimmed.slice(0, DISCORD_FIELD_MAX), inline });
    }
  };

  if (event.queue) {
    pushField('Queue', event.queue);
  }
  if (event.jobName || event.jobId) {
    pushField('Job', `${event.jobName ?? '—'} (\`${event.jobId ?? '—'}\`)`);
  }
  if (event.failedReason) {
    pushField('Reason', event.failedReason.slice(0, 500), false);
  }
  if (event.counts) {
    const parts: string[] = [];
    if (event.counts.failed !== undefined) {
      parts.push(`Failed: ${event.counts.failed}`);
    }
    if (event.counts.backlog !== undefined) {
      parts.push(`Backlog: ${event.counts.backlog}`);
    }
    if (event.counts.workers !== undefined && event.counts.workers !== null) {
      parts.push(`Workers: ${event.counts.workers}`);
    }
    pushField('Counts', parts.join(' · '));
  }

  let description = `**${severityLabel(event.severity)}** · \`${event.trigger}\`\n${event.message}`;
  if (link?.startsWith('https://')) {
    description += `\n\n**[Open in Workbench](${link})**`;
  } else if (link) {
    description += `\n\n${link}`;
  }

  const body = {
    username: senderName,
    avatar_url: iconUrl,
    content: `${emoji} ${event.ruleName}: ${event.message}`,
    embeds: [
      {
        title: `${emoji} ${event.ruleName}`,
        description,
        color: SEVERITY_COLOR[event.severity] ?? DISCORD_NEUTRAL_COLOR,
        fields,
        footer: {
          text: event.status === 'resolved' ? '✅ Resolved' : '🔔 Firing',
        },
        timestamp: new Date(event.firedAt).toISOString(),
      },
    ],
  };

  return {
    url: contactPoint.url,
    headers: { 'Content-Type': 'application/json' },
    body,
  };
}

export function formatDestinationPayload(
  contactPoint: AlertContactPoint,
  event: AlertEvent,
  dashboardUrl?: string,
): FormattedDestinationPayload {
  if (contactPoint.preset === 'slack') {
    return formatSlackPayload(contactPoint, event, dashboardUrl);
  }
  if (contactPoint.preset === 'discord') {
    return formatDiscordPayload(contactPoint, event, dashboardUrl);
  }
  return formatWebhookPayload(contactPoint, event, dashboardUrl);
}

export async function deliverToContactPoint(
  contactPoint: AlertContactPoint,
  event: AlertEvent,
  dashboardUrl?: string,
): Promise<{ success: boolean; error?: string }> {
  if (!contactPoint.enabled) {
    return { success: false, error: 'Contact point disabled' };
  }

  const { url, headers, body } = formatDestinationPayload(
    contactPoint,
    event,
    dashboardUrl,
  );

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let error = `HTTP ${res.status}`;
      try {
        const json = JSON.parse(text) as { error?: string; ok?: boolean };
        if (json.error) error += `: ${json.error}`;
      } catch {
        if (text) error += `: ${text.slice(0, 200)}`;
      }
      return { success: false, error };
    }
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Delivery failed',
    };
  }
}
