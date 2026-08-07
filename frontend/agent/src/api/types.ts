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
};

export type LabviewConfig = {
  cli_path?: string;
  [key: string]: unknown;
};
