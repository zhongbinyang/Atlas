export type Agent = {
  id: string;
  name: string;
  ip: string;
  port: number;
  status: string;
  busy: boolean;
  cpu_percent: number;
  memory_percent: number;
  last_seen_at: string;
};

export type TelemetryFilters = {
  query: string;
  status: 'all' | 'online' | 'busy' | 'offline';
  sort: 'name' | 'status' | 'cpu_desc' | 'memory_desc';
  abnormalOnly: boolean;
};

type AgentStatus = 'offline' | 'busy' | 'online';

export function agentStatus(agent: Agent): AgentStatus {
  if (agent.status === 'offline') return 'offline';
  return agent.busy ? 'busy' : 'online';
}

export function getAgentTelemetry(
  agents: Agent[],
  filters: TelemetryFilters,
): {
  summary: { total: number; online: number; busy: number; offline: number };
  visibleAgents: Agent[];
} {
  const source = Array.isArray(agents) ? agents : [];
  const options = filters || {};
  const query = String(options.query || '').trim().toLocaleLowerCase();
  const status = options.status || 'all';
  const sort = options.sort || 'name';
  const abnormalOnly = Boolean(options.abnormalOnly);
  const summary = { total: source.length, online: 0, busy: 0, offline: 0 };

  for (const agent of source) {
    const kind = agentStatus(agent);
    if (kind === 'offline') summary.offline += 1;
    else {
      summary.online += 1;
      if (kind === 'busy') summary.busy += 1;
    }
  }

  const visibleAgents = source
    .filter((agent) => {
      const kind = agentStatus(agent);
      if (status !== 'all' && kind !== status && !(status === 'online' && kind === 'busy')) {
        return false;
      }
      if (abnormalOnly && kind !== 'offline') return false;
      if (!query) return true;
      const address = String(agent.ip || '') + ':' + String(agent.port == null ? '' : agent.port);
      return [agent.name, agent.ip, agent.port, address].some((value) =>
        String(value == null ? '' : value)
          .toLocaleLowerCase()
          .includes(query),
      );
    })
    .slice();

  const numericDescending =
    (field: 'cpu_percent' | 'memory_percent') =>
    (a: Agent, b: Agent): number => {
      const diff = Number(b[field] || 0) - Number(a[field] || 0);
      return diff || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    };
  const statusRank: Record<AgentStatus, number> = { offline: 0, busy: 1, online: 2 };
  const comparators: Record<TelemetryFilters['sort'], (a: Agent, b: Agent) => number> = {
    name: (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'),
    status: (a, b) =>
      statusRank[agentStatus(a)] - statusRank[agentStatus(b)] ||
      String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'),
    cpu_desc: numericDescending('cpu_percent'),
    memory_desc: numericDescending('memory_percent'),
  };
  visibleAgents.sort(comparators[sort] || comparators.name);

  return { summary, visibleAgents };
}

export function formatAgentHeartbeat(value: string, now?: number | Date): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '—';
  const elapsedSeconds = Math.max(
    0,
    Math.floor((new Date(now || Date.now()).getTime() - date.getTime()) / 1000),
  );
  let relative;
  if (elapsedSeconds < 60) relative = elapsedSeconds + ' 秒前';
  else if (elapsedSeconds < 3600) relative = Math.floor(elapsedSeconds / 60) + ' 分钟前';
  else if (elapsedSeconds < 86400) relative = Math.floor(elapsedSeconds / 3600) + ' 小时前';
  else relative = Math.floor(elapsedSeconds / 86400) + ' 天前';
  return relative + ' · ' + date.toLocaleString('zh-CN');
}
