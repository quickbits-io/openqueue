import type { EnqueueMeta, Principal, RunPrincipal } from '@openqueue/core';

/** Project a {@link Principal} to the identity slice stamped onto runs/schedules. */
export function toRunPrincipal(principal: Principal): RunPrincipal {
  const runPrincipal: RunPrincipal = {
    authenticator: principal.authenticator,
    principalId: principal.principalId,
    principalType: principal.principalType,
  };
  if (principal.tenantId !== undefined) {
    runPrincipal.tenantId = principal.tenantId;
  }
  return runPrincipal;
}

/**
 * Strip any inbound `enqueuedBy` (reserved, anti-spoof) and stamp the verified
 * principal when present. Returns `undefined` only when there is nothing to
 * carry (no meta and no principal).
 */
export function stampMeta(
  meta: EnqueueMeta | undefined,
  principal: Principal | undefined,
): EnqueueMeta | undefined {
  if (principal === undefined) {
    if (meta === undefined) return undefined;
    return 'enqueuedBy' in meta ? stripEnqueuedBy(meta) : meta;
  }
  const base = meta === undefined ? {} : stripEnqueuedBy(meta);
  base.enqueuedBy = toRunPrincipal(principal);
  return base;
}

/**
 * Whether a tenant-scoped caller may act on a resource. A principal without a
 * `tenantId` (or no principal) sees everything; a tenant-scoped principal only
 * sees resources whose `enqueuedBy.tenantId` matches. Unowned resources are
 * denied to tenant-scoped callers.
 */
export function canAccess(
  principal: Principal | undefined,
  resourceMeta: EnqueueMeta,
): boolean {
  const tenantId = principal?.tenantId;
  if (tenantId === undefined) return true;
  return resourceMeta.enqueuedBy?.tenantId === tenantId;
}

/**
 * Inject/merge `{ enqueuedBy: { tenantId } }` into a deep meta filter when the
 * caller is tenant-scoped, forcing their own `tenantId` so they cannot widen
 * the query to another tenant.
 */
export function scopeMetaFilter(
  principal: Principal | undefined,
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const tenantId = principal?.tenantId;
  if (tenantId === undefined) return meta;
  const base = meta ?? {};
  const existing = isRecord(base.enqueuedBy) ? base.enqueuedBy : {};
  return { ...base, enqueuedBy: { ...existing, tenantId } };
}

function stripEnqueuedBy(meta: EnqueueMeta): EnqueueMeta {
  const result: EnqueueMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    if (key !== 'enqueuedBy') result[key] = value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
