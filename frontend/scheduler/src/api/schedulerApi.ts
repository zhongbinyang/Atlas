import { apiRequest } from './client';
import type { Agent, AgentConfigSummary, AgentConfigTemplate, GeneralTemplate, SequenceTemplate, UnitRow, ViTemplate } from './types';

const withAgentFilter = (path: string, agentId?: string): string =>
  path + (agentId ? `?agent_id=${encodeURIComponent(agentId)}` : '');

export const schedulerApi = {
  listAgents: () => apiRequest<Agent[]>('/api/agents'),
  listViTemplates: (agentId?: string) =>
    apiRequest<ViTemplate[]>(withAgentFilter('/api/vi-templates', agentId)),
  listGeneralTemplates: (agentId?: string) =>
    apiRequest<GeneralTemplate[]>(withAgentFilter('/api/general-templates', agentId)),
  deleteViTemplate: (id: string | number) =>
    apiRequest<void>(`/api/vi-templates/${encodeURIComponent(String(id))}`, { method: 'DELETE' }),
  deleteGeneralTemplate: (id: string | number) =>
    apiRequest<void>(`/api/general-templates/${encodeURIComponent(String(id))}`, {
      method: 'DELETE',
    }),
  listSequenceTemplates: () => apiRequest<SequenceTemplate[]>('/api/sequence-templates'),
  deleteSequenceTemplate: (id: string | number) =>
    apiRequest<void>(`/api/sequence-templates/${encodeURIComponent(String(id))}`, {
      method: 'DELETE',
    }),
  listUnits: async () => {
    const data = await apiRequest<{ units?: UnitRow[] }>('/api/units');
    return Array.isArray(data.units) ? data.units : [];
  },
  saveUnits: (units: UnitRow[]) =>
    apiRequest<{ units?: UnitRow[] }>('/api/units', {
      method: 'PUT',
      body: JSON.stringify({ units }),
    }),
  listAgentConfigSummaries: async () => {
    const data = await apiRequest<{ items?: AgentConfigSummary[] }>('/api/agent-configs');
    return Array.isArray(data.items) ? data.items : [];
  },
  getAgentSettings: (agentId: string) =>
    apiRequest<unknown>(`/api/agents/${encodeURIComponent(agentId)}/settings`),
  getAgentChannels: async (agentId: string) => {
    const data = await apiRequest<{ channels?: unknown[] }>(
      `/api/agents/${encodeURIComponent(agentId)}/channels`,
    );
    return Array.isArray(data.channels) ? data.channels : [];
  },
  listAgentConfigTemplates: async () => {
    const data = await apiRequest<{ items?: AgentConfigTemplate[] }>('/api/agent-config-templates');
    return Array.isArray(data.items) ? data.items : [];
  },
  getAgentConfigTemplate: (id: string | number) =>
    apiRequest<Record<string, unknown>>(
      `/api/agent-config-templates/${encodeURIComponent(String(id))}`,
    ),
  deleteAgentConfigTemplate: (id: string | number) =>
    apiRequest<void>(`/api/agent-config-templates/${encodeURIComponent(String(id))}`, {
      method: 'DELETE',
    }),
};
