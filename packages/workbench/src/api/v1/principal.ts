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
 * Namespace a caller-supplied schedule deduplication key under the caller's
 * tenant. Schedule stores treat a duplicate key as an upsert, so without this a
 * tenant-scoped caller could guess another tenant's key and overwrite (and
 * re-own) their schedule before any `canAccess` check runs. Unscoped principals
 * (operators) keep the raw key.
 *
 * Idempotent: the scoped key is echoed back on the wire, so a read-modify-write
 * that resends it must not double-scope (`t:t1:t:t1:foo`). A key already
 * carrying *this* principal's own `t:<tenant>:` prefix is left as-is — a tenant
 * that deliberately names a key `t:t1:foo` simply collapses onto the same
 * schedule as scoping `foo`, which is harmless (same tenant). A key bearing
 * *another* tenant's prefix is still re-scoped, preserving isolation.
 */
export function scopeDedupeKey(
  principal: Principal | undefined,
  key: string,
): string;
export function scopeDedupeKey(
  principal: Principal | undefined,
  key: string | undefined,
): string | undefined;
export function scopeDedupeKey(
  principal: Principal | undefined,
  key: string | undefined,
): string | undefined {
  const tenantId = principal?.tenantId;
  if (tenantId === undefined || key === undefined) return key;
  const prefix = `t:${encodeURIComponent(tenantId)}:`;
  return key.startsWith(prefix) ? key : `${prefix}${key}`;
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
