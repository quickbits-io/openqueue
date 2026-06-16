export const DEFAULT_NAMESPACE = 'openqueue';
export const DEFAULT_BULL_PREFIX = 'bull';

export interface NamespaceOptions {
  namespace?: string;
  bullPrefix?: string;
}

export interface ResolvedNamespace {
  namespace: string;
  bullPrefix: string;
}

export function resolveNamespace(
  options: NamespaceOptions = {},
): ResolvedNamespace {
  const namespace = cleanNamespace(options.namespace ?? DEFAULT_NAMESPACE);
  return {
    namespace,
    bullPrefix: options.bullPrefix ?? DEFAULT_BULL_PREFIX,
  };
}

export function redisKey(namespace: string, key: string): string {
  return `${namespace}:queue:${key}:v1`;
}

export function bullPrefix(options: NamespaceOptions = {}): string {
  const resolved = resolveNamespace(options);
  return `${resolved.bullPrefix}:${resolved.namespace}`;
}

function cleanNamespace(value: string): string {
  const namespace = value.trim();
  if (!namespace) {
    throw new Error('@openqueue/sdk: namespace cannot be empty');
  }
  return namespace.replace(/[^a-zA-Z0-9:_-]/g, '-');
}
