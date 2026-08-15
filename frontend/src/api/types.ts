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

export type AgentConfigProfile = {
  id: string;
  agent_id: string;
  name: string;
  setting: Record<string, unknown>;
  is_active: boolean;
  source_filename: string;
  updated_at?: string;
};

export type CreateProfileBody = {
  name: string;
  setting: Record<string, unknown>;
  source_filename: string;
  activate: boolean;
};

export type TestRunListItem = {
  id: string;
  agent_id: string | null;
  channel_index: number;
  channel_name: string;
  sequence_template_id: number | null;
  overall: string;
  elapsed_ms: number;
  started_at: string;
  finished_at: string;
  sn: string;
  work_order: string;
  hostname: string;
};

export type TestRunListPage = {
  items: TestRunListItem[];
  total: number;
};

export type TestRunListParams = {
  agent_id?: string;
  overall?: string;
  sn?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

export type TestRunContext = {
  sn: string;
  work_order: string;
  hostname: string;
  product_pn?: string;
  corner?: string;
  config_revision?: number | null;
  device_profile_id?: string;
  device_profile_name?: string;
  calibration_profile_id?: string;
  calibration_profile_name?: string;
};

export type TestRunStep = {
  position: number;
  queue_item_id: string;
  template_id: string;
  template_source: string;
  name: string;
  kind: string;
  ok: boolean;
  status: string;
  elapsed_ms: number;
  measured: unknown;
  limits: unknown;
  result: unknown;
  error: string | null;
  spec_template_id: number | null;
  spec_section: string;
};

export type TestRunDetail = {
  id: string;
  agent_id: string | null;
  channel_index: number;
  channel_name: string;
  sequence_template_id: number | null;
  run_generation: number;
  overall: string;
  stopped: boolean;
  failed_at: number | null;
  elapsed_ms: number;
  started_at: string;
  finished_at: string;
  created_at: string;
  context: TestRunContext;
  steps: TestRunStep[];
};
