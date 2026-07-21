export const DEFAULT_NAMESPACE = 'openqueue';

export interface NamespaceOptions {
  namespace?: string;
}

export interface ResolvedNamespace {
  namespace: string;
}

export function resolveNamespace(
  options: NamespaceOptions = {},
): ResolvedNamespace {
  return { namespace: cleanNamespace(options.namespace ?? DEFAULT_NAMESPACE) };
}

function cleanNamespace(value: string): string {
  const namespace = value.trim();
  if (!namespace) {
    throw new Error('@openqueue/sdk: namespace cannot be empty');
  }
  return namespace.replace(/[^a-zA-Z0-9:_-]/g, '-');
}
