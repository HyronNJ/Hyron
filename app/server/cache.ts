const entries = new Map<string, unknown>();

export function readCache<T>(key: string): T | null {
  return (entries.get(key) as T | undefined) ?? null;
}

export function writeCache(key: string, value: unknown) {
  entries.set(key, value);
}
