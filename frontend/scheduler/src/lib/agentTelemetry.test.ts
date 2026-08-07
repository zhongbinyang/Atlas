import { describe, expect, it } from 'vitest';
import {
  agentStatus,
  formatAgentHeartbeat,
  getAgentTelemetry,
  type Agent,
} from './agentTelemetry';

const agents: Agent[] = [
  {
    id: '1',
    name: 'B',
    ip: '10.0.0.2',
    port: 26631,
    status: 'online',
    busy: true,
    cpu_percent: 80,
    memory_percent: 10,
    last_seen_at: '2026-08-07T01:00:00.000Z',
  },
  {
    id: '2',
    name: 'A',
    ip: '10.0.0.1',
    port: 26631,
    status: 'online',
    busy: false,
    cpu_percent: 10,
    memory_percent: 50,
    last_seen_at: '2026-08-07T01:00:00.000Z',
  },
  {
    id: '3',
    name: 'C',
    ip: '10.0.0.3',
    port: 26631,
    status: 'offline',
    busy: false,
    cpu_percent: 0,
    memory_percent: 0,
    last_seen_at: '2026-08-07T01:00:00.000Z',
  },
];

describe('agentStatus', () => {
  it('treats offline status as offline before busy state', () => {
    expect(agentStatus({ ...agents[0], status: 'offline', busy: true })).toBe('offline');
  });

  it('treats busy online agents as busy', () => {
    expect(agentStatus(agents[0])).toBe('busy');
  });
});

describe('getAgentTelemetry', () => {
  it('summarizes counts', () => {
    const { summary } = getAgentTelemetry(agents, {
      query: '',
      status: 'all',
      sort: 'name',
      abnormalOnly: false,
    });

    expect(summary).toEqual({ total: 3, online: 2, busy: 1, offline: 1 });
  });

  it('filters busy and sorts by name', () => {
    const { visibleAgents } = getAgentTelemetry(agents, {
      query: '',
      status: 'busy',
      sort: 'name',
      abnormalOnly: false,
    });

    expect(visibleAgents.map((a) => a.id)).toEqual(['1']);
  });

  it('status=online includes busy', () => {
    const { visibleAgents } = getAgentTelemetry(agents, {
      query: '',
      status: 'online',
      sort: 'name',
      abnormalOnly: false,
    });

    expect(visibleAgents.map((a) => a.id).sort()).toEqual(['1', '2']);
  });

  it('filters by address query and sorts by memory descending', () => {
    const { visibleAgents } = getAgentTelemetry(agents, {
      query: '10.0.0',
      status: 'all',
      sort: 'memory_desc',
      abnormalOnly: false,
    });

    expect(visibleAgents.map((a) => a.id)).toEqual(['2', '1', '3']);
  });

  it('abnormalOnly shows only offline agents', () => {
    const { visibleAgents } = getAgentTelemetry(agents, {
      query: '',
      status: 'all',
      sort: 'status',
      abnormalOnly: true,
    });

    expect(visibleAgents.map((a) => a.id)).toEqual(['3']);
  });
});

describe('formatAgentHeartbeat', () => {
  it('formats invalid heartbeat values as a dash', () => {
    expect(formatAgentHeartbeat('')).toBe('—');
    expect(formatAgentHeartbeat('not-a-date')).toBe('—');
  });

  it('formats relative heartbeat age with localized date text', () => {
    const formatted = formatAgentHeartbeat(
      '2026-08-07T01:00:00.000Z',
      new Date('2026-08-07T01:03:00.000Z'),
    );

    expect(formatted).toMatch(/^3 分钟前 · /);
    expect(formatted).toContain('2026');
  });
});
