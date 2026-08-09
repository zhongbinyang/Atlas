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

export type AgentConfigSummary = {
  agent_id: string;
  agent_name: string;
  agent_status: string;
  agent_ip: string;
  variable_count: number;
  device_profile_count: number;
  calibration_profile_count: number;
  active_device_name?: string | null;
  active_calibration_name?: string | null;
  channel_count: number;
  array_expand_mode?: string;
  settings_updated_at?: string | null;
  [key: string]: unknown;
};

export type AgentConfigTemplate = {
  id: number | string;
  name: string;
  note?: string;
  source_agent_id?: string | null;
  source_agent_name?: string;
  created_by_agent_id?: string;
  created_by_agent_name?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
};

export type SpecTemplateSummary = {
  id: number;
  name: string;
  product_pn: string;
  source_filename: string;
  section_count: number;
  created_by_agent_name?: string | null;
  updated_at: string;
};

export type SpecTemplateDetail = {
  id: number;
  name: string;
  product_pn: string;
  note: string;
  source_filename: string;
  section_count: number;
  spec: {
    version?: number;
    sections?: Record<
      string,
      Record<string, { min: number | null; max: number | null }>
    >;
  };
  created_by_agent_id?: string | null;
  created_by_agent_name?: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateSpecTemplateRequest = {
  ini_text: string;
  name?: string;
  product_pn?: string;
  note?: string;
  source_filename?: string;
  created_by_agent_id?: string;
};
