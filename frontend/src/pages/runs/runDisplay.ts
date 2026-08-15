export function displayOptional(value?: string | null): string {
  return value && value.trim() !== '' ? value : '—';
}

export function agentLabel(
  agentId: string | null | undefined,
  agents: { id: string; name: string }[],
  hostname?: string,
): string {
  const found = agents.find((a) => a.id === agentId);
  if (found?.name) return found.name;
  if (hostname && hostname.trim() !== '') return hostname;
  return agentId && agentId.trim() !== '' ? agentId : '—';
}
