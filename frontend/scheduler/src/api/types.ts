export type { Agent } from '../lib/agentTelemetry';

export type ViTemplate = {
  id: number | string;
  name: string;
  kind?: string;
  origin_agent_name?: string;
  vi_path?: string;
  timeout_secs?: number;
  inputs?: unknown;
};

export type GeneralTemplate = {
  id: number | string;
  name: string;
  kind?: string;
  origin_agent_name?: string;
  inputs?: unknown;
};

export type SequenceTemplate = {
  id: number | string;
  name: string;
  [key: string]: unknown;
};

export type UnitRow = {
  symbol: string;
  description?: string;
  [key: string]: unknown;
};
