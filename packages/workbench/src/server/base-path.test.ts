import { describe, expect, test } from 'bun:test';
import { computeBasePath, resolveBasePath } from './base-path';

describe('base path resolution', () => {
  test('defaults standalone dashboard routes to root', () => {
    expect(computeBasePath('/')).toBe('/');
    expect(computeBasePath('/runs')).toBe('/');
    expect(computeBasePath('/errors')).toBe('/');
    expect(computeBasePath('/alerts')).toBe('/');
    expect(computeBasePath('/queues/email')).toBe('/');
    expect(computeBasePath('/queues/email/jobs/123')).toBe('/');
    expect(computeBasePath('/flows/email/123')).toBe('/');
  });

  test('infers mounted dashboard prefixes from deep links', () => {
    expect(computeBasePath('/admin/jobs')).toBe('/admin/jobs/');
    expect(computeBasePath('/admin/jobs/runs')).toBe('/admin/jobs/');
    expect(computeBasePath('/admin/jobs/errors')).toBe('/admin/jobs/');
    expect(computeBasePath('/admin/jobs/alerts')).toBe('/admin/jobs/');
    expect(computeBasePath('/admin/jobs/queues/email')).toBe('/admin/jobs/');
    expect(computeBasePath('/admin/jobs/queues/email/jobs/123')).toBe(
      '/admin/jobs/',
    );
    expect(computeBasePath('/admin/jobs/flows/email/123')).toBe('/admin/jobs/');
  });

  test('uses explicit basePath when the host strips the mount path', () => {
    expect(resolveBasePath('/admin/jobs', '/queues/email')).toBe(
      '/admin/jobs/',
    );
  });
});
