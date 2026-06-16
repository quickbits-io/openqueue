import { describe, expect, test } from 'bun:test';
import {
  formatDiscordPayload,
  formatSlackPayload,
  isDiscordWebhookUrl,
  isSlackIncomingWebhookUrl,
  validateContactPointUrl,
} from './alert-destinations';
import type { AlertContactPoint, AlertEvent } from './types';

const slackCp: AlertContactPoint = {
  id: 'cp-1',
  name: 'Slack #ops',
  preset: 'slack',
  url: 'https://hooks.slack.com/services/T000/B000/XXXXXXXX',
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const discordCp: AlertContactPoint = {
  id: 'cp-2',
  name: 'Discord #ops',
  preset: 'discord',
  url: 'https://discord.com/api/webhooks/123/abcDEF',
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const sampleEvent: AlertEvent = {
  id: 'evt-1',
  ruleId: 'rule-1',
  ruleName: 'Job failed',
  trigger: 'job_failed',
  severity: 'warning',
  status: 'firing',
  fingerprint: 'fp-1',
  queue: 'email',
  jobId: '42',
  jobName: 'sendReceipt',
  message: 'Job sendReceipt failed in email',
  failedReason: 'SMTP timeout',
  firedAt: Date.now(),
};

describe('isSlackIncomingWebhookUrl', () => {
  test('accepts standard Slack webhook URLs', () => {
    expect(
      isSlackIncomingWebhookUrl(
        'https://hooks.slack.com/services/T000/B000/XXXXXXXX',
      ),
    ).toBe(true);
  });

  test('accepts GovSlack webhook URLs', () => {
    expect(
      isSlackIncomingWebhookUrl(
        'https://hooks.slack-gov.com/services/T000/B000/XXXXXXXX',
      ),
    ).toBe(true);
  });

  test('rejects non-Slack URLs', () => {
    expect(isSlackIncomingWebhookUrl('https://example.com/webhook')).toBe(
      false,
    );
  });
});

describe('isDiscordWebhookUrl', () => {
  test('accepts standard Discord webhook URLs', () => {
    expect(
      isDiscordWebhookUrl('https://discord.com/api/webhooks/123/abcDEF'),
    ).toBe(true);
  });

  test('accepts PTB Discord webhook URLs', () => {
    expect(
      isDiscordWebhookUrl('https://ptb.discord.com/api/webhooks/123/abcDEF'),
    ).toBe(true);
  });

  test('rejects non-Discord URLs', () => {
    expect(isDiscordWebhookUrl('https://example.com/api/webhooks/1/x')).toBe(
      false,
    );
  });
});

describe('validateContactPointUrl', () => {
  test('requires Slack webhook host for slack preset', () => {
    expect(
      validateContactPointUrl('slack', 'https://example.com/hook'),
    ).toContain('incoming webhook');
  });

  test('requires Discord webhook host for discord preset', () => {
    expect(
      validateContactPointUrl('discord', 'https://example.com/hook'),
    ).toContain('discord.com');
  });

  test('accepts a valid Discord webhook URL', () => {
    expect(
      validateContactPointUrl(
        'discord',
        'https://discord.com/api/webhooks/123/abcDEF',
      ),
    ).toBeUndefined();
  });

  test('allows generic https URLs for webhook preset', () => {
    expect(
      validateContactPointUrl('webhook', 'https://example.com/hook'),
    ).toBeUndefined();
  });
});

describe('formatSlackPayload', () => {
  test('includes required text fallback and Block Kit blocks', () => {
    const { url, headers, body } = formatSlackPayload(slackCp, sampleEvent);

    expect(url).toBe(slackCp.url);
    expect(headers['Content-Type']).toBe('application/json');

    const payload = body as {
      text: string;
      blocks: Array<{ type: string }>;
    };
    expect(payload.text).toContain('Job failed');
    expect(payload.blocks.some((b) => b.type === 'header')).toBe(true);
    expect(payload.blocks.some((b) => b.type === 'section')).toBe(true);
  });

  test('uses a button for https dashboard links', () => {
    const { body } = formatSlackPayload(
      slackCp,
      sampleEvent,
      'https://jobs.example.com/jobs',
    );
    const payload = body as { blocks: Array<{ type: string }> };
    expect(payload.blocks.some((b) => b.type === 'actions')).toBe(true);
  });

  test('uses a text link for http dev dashboard URLs', () => {
    const { body } = formatSlackPayload(
      slackCp,
      sampleEvent,
      'http://localhost:3010/jobs',
    );
    const payload = body as {
      blocks: Array<{ type: string; elements?: unknown[] }>;
    };
    expect(payload.blocks.some((b) => b.type === 'actions')).toBe(false);
    const context = payload.blocks.find((b) => b.type === 'context');
    expect(context?.elements).toBeDefined();
  });
});

describe('formatDiscordPayload', () => {
  test('includes a colored embed and content fallback', () => {
    const { url, headers, body } = formatDiscordPayload(discordCp, sampleEvent);

    expect(url).toBe(discordCp.url);
    expect(headers['Content-Type']).toBe('application/json');

    const payload = body as {
      content: string;
      embeds: Array<{ color: number; title: string }>;
    };
    expect(payload.content).toContain('Job failed');
    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds[0]?.color).toBe(0xf59e0b);
    expect(payload.embeds[0]?.title).toContain('Job failed');
  });

  test('honors a custom sender name', () => {
    const { body } = formatDiscordPayload(
      { ...discordCp, displayName: 'Ops Bot' },
      sampleEvent,
    );
    expect((body as { username: string }).username).toBe('Ops Bot');
  });

  test('links to the dashboard for https URLs', () => {
    const { body } = formatDiscordPayload(
      discordCp,
      sampleEvent,
      'https://jobs.example.com/jobs',
    );
    const payload = body as { embeds: Array<{ description: string }> };
    expect(payload.embeds[0]?.description).toContain('Open in Workbench');
  });
});
