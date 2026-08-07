import { apiRequest } from './client';
import type { Agent, GeneralTemplate, SequenceTemplate, UnitRow, ViTemplate } from './types';

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
};
