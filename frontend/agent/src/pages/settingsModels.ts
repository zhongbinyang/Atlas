/** Shared helpers for Agent 配置 page (variables / profiles / channels). */

export const PROFILE_META_DESCRIPTIONS = '__descriptions__';

export type FlatPreviewRow = {
  section: string;
  key: string;
  value: string;
  flatName: string;
  description: string;
};

export type ConfigProfile = {
  id: string;
  name: string;
  setting: Record<string, unknown>;
  is_active: boolean;
  source_filename: string;
  updated_at?: string | null;
};

export function isSystemVarName(name: string): boolean {
  return name === 'Hostname' || name === 'IP';
}

export function normalizeArrayExpandMode(mode: unknown): 'semicolon' | 'json' {
  return String(mode ?? '').toLowerCase() === 'json' ? 'json' : 'semicolon';
}

export function sanitizeDeviceCfgIdent(raw: unknown): string {
  let s = String(raw || '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s) return '';
  if (!/^[A-Za-z_]/.test(s)) s = `V_${s}`;
  if (s.length > 64) s = s.slice(0, 64).replace(/_+$/g, '');
  return s;
}

export function normalizeDeviceCfgValue(raw: unknown): string {
  let s = String(raw == null ? '' : raw).trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

export function coerceIniScalar(token: unknown): string | number {
  const t = String(token == null ? '' : token).trim();
  if (t === '') return '';
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(t)) {
    const n = Number(t);
    if (!Number.isNaN(n) && Number.isFinite(n)) return n;
  }
  return t;
}

export function coerceIniScalarOrArray(raw: unknown): string | number | Array<string | number> {
  const s = normalizeDeviceCfgValue(raw);
  if (!s && s !== '0') return '';
  if (!s.includes(';')) return coerceIniScalar(s);
  const parts = s
    .split(';')
    .map((p) => String(p).trim())
    .filter((p) => p !== '');
  if (parts.length <= 1) return coerceIniScalar(parts.length ? parts[0] : s);
  return parts.map(coerceIniScalar);
}

export function settingValueToEditText(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value
      .map((v) => (v == null ? '' : String(v)))
      .filter((v) => v !== '')
      .join(';');
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function editTextToSettingValue(text: string): string | number | Array<string | number> {
  return coerceIniScalarOrArray(text);
}

export function isProfileMetaSection(section: unknown): boolean {
  return String(section || '').startsWith('__');
}

export function parseDeviceCfgIni(text: string): Array<{ section: string; key: string; value: string }> {
  const entries: Array<{ section: string; key: string; value: string }> = [];
  let section = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith(';') || line.startsWith('//') || line.startsWith('/*')) {
      continue;
    }
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!key || key.startsWith('#')) continue;
    entries.push({ section, key, value });
  }
  return entries;
}

export function parseTomlSetting(text: string): Record<string, Record<string, string>> {
  const setting: Record<string, Record<string, string>> = {};
  let section = '';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith(';')) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      section = sec[1].trim().replace(/^"|"$/g, '');
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^"|"$/g, '');
    let value = line.slice(eq + 1).trim();
    if (!key) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
      value = value.replace(/^'|'$/g, '');
    }
    value = String(value).trim();
    if (!value && value !== '0') continue;
    const secName = section || 'Default';
    if (!setting[secName]) setting[secName] = {};
    setting[secName][key] = value;
  }
  return setting;
}

export function settingToFlatPreviewRows(setting: unknown): FlatPreviewRow[] {
  const rows: FlatPreviewRow[] = [];
  const obj =
    setting !== null && typeof setting === 'object' && !Array.isArray(setting)
      ? (setting as Record<string, unknown>)
      : {};
  const descsRaw = obj[PROFILE_META_DESCRIPTIONS];
  const descs =
    descsRaw !== null && typeof descsRaw === 'object' && !Array.isArray(descsRaw)
      ? (descsRaw as Record<string, unknown>)
      : {};
  const sections = Object.keys(obj).sort();
  for (const section of sections) {
    if (isProfileMetaSection(section)) continue;
    const keysObj = obj[section];
    if (!keysObj || typeof keysObj !== 'object' || Array.isArray(keysObj)) continue;
    const keys = Object.keys(keysObj as Record<string, unknown>).sort();
    for (const key of keys) {
      const rawVal = (keysObj as Record<string, unknown>)[key];
      if (rawVal == null) continue;
      if (Array.isArray(rawVal) && !rawVal.length) continue;
      const valueText = settingValueToEditText(rawVal);
      if (!valueText && valueText !== '0') continue;
      const flatName = sanitizeDeviceCfgIdent(`${section}_${key}`);
      if (!flatName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(flatName)) continue;
      rows.push({
        section,
        key,
        value: valueText,
        flatName,
        description: String(descs[flatName] || `[${section}] ${key}`),
      });
    }
  }
  return rows;
}

export function iniToSettingJson(text: string): {
  setting: Record<string, Record<string, string | number | Array<string | number>>>;
  rows: FlatPreviewRow[];
} {
  const setting: Record<string, Record<string, string | number | Array<string | number>>> = {};
  for (const e of parseDeviceCfgIni(text)) {
    const value = coerceIniScalarOrArray(e.value);
    if (value === '' || value == null) continue;
    if (Array.isArray(value) && !value.length) continue;
    const section = e.section || 'Default';
    if (!setting[section]) setting[section] = {};
    setting[section][e.key] = value;
  }
  return { setting, rows: settingToFlatPreviewRows(setting) };
}

export function textToSettingJson(
  text: string,
  sourceFilename = '',
): { setting: Record<string, unknown>; rows: FlatPreviewRow[] } {
  const name = String(sourceFilename || '').toLowerCase();
  const sample = String(text || '').trim();
  if (/\.toml$/i.test(name)) {
    const setting = parseTomlSetting(text);
    return { setting, rows: settingToFlatPreviewRows(setting) };
  }
  if (!/\.ini$/i.test(name) && /^\s*\[[^\]]+\]\s*$/m.test(sample) && /=\s*["']/.test(sample)) {
    const setting = parseTomlSetting(text);
    return { setting, rows: settingToFlatPreviewRows(setting) };
  }
  return iniToSettingJson(text);
}

export function flatRowsToSetting(
  rows: FlatPreviewRow[],
  previousSetting?: Record<string, unknown> | null,
): Record<string, unknown> {
  const setting: Record<string, unknown> = {};
  const descs: Record<string, string> = {};
  for (const row of rows || []) {
    if (!row.section || !row.key) continue;
    const value = editTextToSettingValue(row.value);
    if (value === '' || value == null) continue;
    if (Array.isArray(value) && !value.length) continue;
    if (!setting[row.section] || typeof setting[row.section] !== 'object') {
      setting[row.section] = {};
    }
    (setting[row.section] as Record<string, unknown>)[row.key] = value;
    if (row.flatName && row.description) descs[row.flatName] = row.description;
  }
  if (previousSetting && typeof previousSetting === 'object') {
    for (const sec of Object.keys(previousSetting)) {
      if (isProfileMetaSection(sec) && sec !== PROFILE_META_DESCRIPTIONS) {
        setting[sec] = previousSetting[sec];
      }
    }
  }
  if (Object.keys(descs).length) {
    setting[PROFILE_META_DESCRIPTIONS] = descs;
  }
  return setting;
}

export function overlayObjectFromUnknown(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k) continue;
    out[k] = v == null ? '' : String(v);
  }
  return out;
}

export function normalizeConfigProfile(raw: unknown): ConfigProfile {
  const item =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const setting =
    item.setting !== null && typeof item.setting === 'object' && !Array.isArray(item.setting)
      ? (item.setting as Record<string, unknown>)
      : {};
  return {
    id: String(item.id ?? ''),
    name: String(item.name ?? ''),
    setting,
    is_active: !!item.is_active,
    source_filename: String(item.source_filename ?? ''),
    updated_at: item.updated_at != null ? String(item.updated_at) : null,
  };
}
