import { apiRequest } from './client';
import type { AgentStatus, LabviewConfig } from './types';

export const agentApi = {
  status: () => apiRequest<AgentStatus>('/api/status'),
  registerNow: () => apiRequest<unknown>('/api/register-now', { method: 'POST' }),
  forceRelease: () => apiRequest<unknown>('/api/slot/force-release', { method: 'POST' }),
  labviewConfig: () => apiRequest<LabviewConfig>('/api/labview/config'),
  labviewInspect: (body: unknown) =>
    apiRequest<unknown>('/api/labview/inspect', { method: 'POST', body: JSON.stringify(body) }),
  labviewRun: (body: unknown) =>
    apiRequest<unknown>('/api/labview/run', { method: 'POST', body: JSON.stringify(body) }),
  labviewRegisterTemplate: (body: unknown) =>
    apiRequest<unknown>('/api/labview/register-template', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  labviewAllTemplates: () => apiRequest<unknown[]>('/api/labview/all-templates'),
  delayRun: (body: unknown) =>
    apiRequest<unknown>('/api/general/delay/run', { method: 'POST', body: JSON.stringify(body) }),
  delayRegister: (body: unknown) =>
    apiRequest<unknown>('/api/general/delay/register-template', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  versionRun: () => apiRequest<unknown>('/api/general/version/run', { method: 'POST' }),
  versionRegister: (body: unknown) =>
    apiRequest<unknown>('/api/general/version/register-template', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  restRun: (body: unknown) =>
    apiRequest<unknown>('/api/general/rest/run', { method: 'POST', body: JSON.stringify(body) }),
  restRegister: (body: unknown) =>
    apiRequest<unknown>('/api/general/rest/register-template', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  restTemplates: () => apiRequest<unknown[]>('/api/general/rest/templates'),
  generalAllTemplates: () => apiRequest<unknown[]>('/api/general/all-templates'),
  getSettings: () => apiRequest<unknown>('/api/settings'),
  putSettings: (body: unknown) =>
    apiRequest<unknown>('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
  getUnits: () => apiRequest<unknown>('/api/units'),
  getChannels: () => apiRequest<unknown>('/api/channels'),
  putChannels: (body: unknown) =>
    apiRequest<unknown>('/api/channels', { method: 'PUT', body: JSON.stringify(body) }),
  getRunQueue: () => apiRequest<unknown>('/api/sequence/run-queue'),
  putRunQueue: (body: unknown) =>
    apiRequest<unknown>('/api/sequence/run-queue', { method: 'PUT', body: JSON.stringify(body) }),
  listSequenceTemplates: () => apiRequest<unknown[]>('/api/sequence-templates'),
  saveSequenceTemplate: (body: unknown) =>
    apiRequest<unknown>('/api/sequence-templates', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  loadSequenceTemplate: (id: string | number) =>
    apiRequest<unknown>(`/api/sequence-templates/${encodeURIComponent(String(id))}/load`, {
      method: 'POST',
    }),
  sequenceRun: (body: unknown) =>
    apiRequest<unknown>('/api/sequence/run', { method: 'POST', body: JSON.stringify(body) }),
  sequenceProgress: () => apiRequest<unknown>('/api/sequence/run/progress'),
  sequenceAbort: () => apiRequest<unknown>('/api/sequence/run/abort', { method: 'POST' }),
  sequenceAbortChannel: (index: number) =>
    apiRequest<unknown>(`/api/sequence/run/channels/${encodeURIComponent(String(index))}/abort`, {
      method: 'POST',
    }),
};
