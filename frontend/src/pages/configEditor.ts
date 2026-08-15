export type EditableVariable = {
  _key: string;
  name: string;
  value: string;
  description: string;
};

export type EditableChannel = {
  _key: string;
  channel_index: number;
  name: string;
  enabled: boolean;
  overlayText: string;
};

export type AgentVariablePayload = {
  name: string;
  value: string;
  description: string;
};

export type AgentChannelPayload = {
  channel_index: number;
  name: string;
  enabled: boolean;
  overlay: Record<string, string>;
};

export type PrepareOk<T> = { ok: true } & T;
export type PrepareErr = { ok: false; error: string };
export type PrepareResult<T> = PrepareOk<T> | PrepareErr;

let nextKey = 0;

export function rowKey(prefix: string): string {
  nextKey += 1;
  return `${prefix}-${nextKey}`;
}

export function isSystemVarName(name: string): boolean {
  return name === 'Hostname' || name === 'IP';
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function normalizeArrayExpandMode(value: unknown): 'semicolon' | 'json' {
  return value === 'json' ? 'json' : 'semicolon';
}

export function normalizeVariables(settings: unknown): EditableVariable[] {
  const raw = asRecord(settings).variables;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const row = asRecord(item);
    return {
      _key: rowKey('var'),
      name: String(row.name ?? '').trim(),
      value: row.value == null ? '' : String(row.value),
      description: row.description == null ? '' : String(row.description).trim(),
    };
  });
}

function isValidVariableName(name: string): boolean {
  if (!name || name.length > 64) return false;
  return [...name].every((c, i) => {
    if (i === 0) return /[A-Za-z_]/.test(c);
    return /[A-Za-z0-9_]/.test(c);
  });
}

export function prepareVariablesForSave(
  rows: EditableVariable[],
): PrepareResult<{ variables: AgentVariablePayload[] }> {
  const variables: AgentVariablePayload[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) return { ok: false, error: '变量名不能为空' };
    if (!isValidVariableName(name)) return { ok: false, error: `无效变量名：${name}` };
    if (row.description.length > 200) {
      return { ok: false, error: `变量说明过长：${name}` };
    }
    if (seen.has(name)) return { ok: false, error: `重复变量：${name}` };
    seen.add(name);
    variables.push({
      name,
      value: row.value,
      description: row.description.trim(),
    });
  }
  return { ok: true, variables };
}

export function parseOverlayText(text: string): PrepareResult<{ overlay: Record<string, string> }> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, overlay: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { ok: false, error: 'overlay 不是合法 JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'overlay 必须是 JSON 对象' };
  }
  const overlay: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      return { ok: false, error: `overlay[${key}] 必须是字符串` };
    }
    overlay[key] = value;
  }
  return { ok: true, overlay };
}

function overlayToText(overlay: unknown): string {
  const parsed = parseOverlayText(
    overlay && typeof overlay === 'object' ? JSON.stringify(overlay) : '',
  );
  const obj = parsed.ok ? parsed.overlay : {};
  return JSON.stringify(obj, null, 2);
}

export function normalizeChannels(channels: unknown): EditableChannel[] {
  if (!Array.isArray(channels)) return [];
  return channels.map((item) => {
    const row = asRecord(item);
    const index = Number(row.channel_index);
    return {
      _key: rowKey('ch'),
      channel_index: Number.isFinite(index) ? index : 0,
      name: String(row.name ?? ''),
      enabled: row.enabled !== false,
      overlayText: overlayToText(row.overlay),
    };
  });
}

export function prepareChannelsForSave(
  rows: EditableChannel[],
): PrepareResult<{ channels: AgentChannelPayload[] }> {
  const channels: AgentChannelPayload[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) return { ok: false, error: '通道名称不能为空' };
    if (seen.has(row.channel_index)) {
      return { ok: false, error: `通道序号重复：${row.channel_index}` };
    }
    seen.add(row.channel_index);
    const overlay = parseOverlayText(row.overlayText);
    if (!overlay.ok) return overlay;
    channels.push({
      channel_index: row.channel_index,
      name,
      enabled: row.enabled !== false,
      overlay: overlay.overlay,
    });
  }
  return { ok: true, channels };
}
