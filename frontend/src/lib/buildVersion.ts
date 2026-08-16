export function readBuildVersion(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const version = (data as { version?: unknown }).version;
  if (typeof version !== 'string') return null;
  const trimmed = version.trim();
  return trimmed ? trimmed : null;
}
