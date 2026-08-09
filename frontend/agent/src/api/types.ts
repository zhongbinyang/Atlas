export type AgentStatus = {
  hostname: string;
  ip: string;
  cpu_percent: number;
  memory_percent: number;
  busy: boolean;
  uptime_secs: number;
  can_force_release?: boolean;
  busy_message?: string;
  busy_reason?: string;
  log_dir?: string;
  center_url?: string;
};

export type LabviewConfig = {
  cli_path?: string;
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

export type ViRunQueueStep = {
  id?: string;
  template_source?: string;
  vi_template_id?: number | null;
  general_template_id?: number | null;
  name?: string;
  kind?: string;
  inputs?: unknown;
  outputs?: unknown;
  enabled?: boolean;
  fail_policy?: string;
  limits?: unknown;
  note?: string;
  resources?: string[];
  collapsed?: boolean;
  position?: number;
  spec_template_id?: number | null;
  spec_section?: string;
  spec_metrics?: string[];
};
