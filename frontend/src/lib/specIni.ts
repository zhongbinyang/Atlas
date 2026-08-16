export interface SpecBound {
  min: number | null;
  max: number | null;
}

export interface SpecDocument {
  version: 1;
  sections: Record<string, Record<string, SpecBound>>;
}

export interface SpecParseResult {
  document: SpecDocument;
  warnings: string[];
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('#') || t.startsWith(';') || t.startsWith('//');
}

function parseKeyValue(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || isCommentLine(trimmed)) {
    return null;
  }
  const eq = trimmed.indexOf('=');
  if (eq === -1) {
    return null;
  }
  const key = trimmed.slice(0, eq).trim();
  const value = trimmed.slice(eq + 1).trim();
  if (key.length === 0) {
    return null;
  }
  return [key, value];
}

function parseSectionHeader(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']') || trimmed.length < 3) {
    return null;
  }
  const name = trimmed.slice(1, -1).trim();
  if (name.length === 0) {
    return null;
  }
  return name;
}

function metricBaseAndSide(key: string): [string, boolean] | null {
  if (key.endsWith('_UL')) {
    return [key.slice(0, -3), true];
  }
  if (key.endsWith('_LL')) {
    return [key.slice(0, -3), false];
  }
  return null;
}

export function parseBoundToken(raw: string): number | null {
  const t = raw.trim();
  const lower = t.toLowerCase();
  if (lower === 'inf' || lower === '+inf' || lower === 'infinity') {
    return null;
  }
  if (lower === '-inf' || lower === '-infinity') {
    return null;
  }
  const n = Number(t);
  if (Number.isNaN(n)) {
    return null;
  }
  return n;
}

export function parseSpecIni(text: string): SpecParseResult {
  const sections: Record<string, Record<string, SpecBound>> = {};
  const warnings: string[] = [];
  let currentSection: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || isCommentLine(line)) {
      continue;
    }

    const sectionName = parseSectionHeader(line);
    if (sectionName !== null) {
      currentSection = sectionName;
      if (!(sectionName in sections)) {
        sections[sectionName] = {};
      }
      continue;
    }

    const kv = parseKeyValue(line);
    if (kv === null) {
      continue;
    }
    const [key, value] = kv;

    const metricSide = metricBaseAndSide(key);
    if (metricSide === null) {
      continue;
    }
    const [metric, isUpper] = metricSide;

    if (currentSection === null) {
      warnings.push(`orphan limit key outside section: ${key}`);
      continue;
    }

    const boundValue = parseBoundToken(value);
    const section = sections[currentSection];
    if (!(metric in section)) {
      section[metric] = { min: null, max: null };
    }
    const entry = section[metric];
    if (isUpper) {
      entry.max = boundValue;
    } else {
      entry.min = boundValue;
    }
  }

  if (Object.keys(sections).length === 0) {
    throw new Error('no sections found in spec INI');
  }

  return {
    document: {
      version: 1,
      sections,
    },
    warnings,
  };
}

export function formatSpecParseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'no sections found in spec INI') {
    return '未找到有效的 Section（需包含 [段名] 与 *_UL/*_LL 键）';
  }
  return message;
}

export function specDocumentToJson(doc: SpecDocument): {
  version: number;
  sections: Record<string, Record<string, { min: number | null; max: number | null }>>;
} {
  const sections: Record<string, Record<string, { min: number | null; max: number | null }>> =
    {};

  for (const [sectionName, metrics] of Object.entries(doc.sections)) {
    const metricMap: Record<string, { min: number | null; max: number | null }> = {};
    for (const [metricName, bound] of Object.entries(metrics)) {
      metricMap[metricName] = {
        min: bound.min,
        max: bound.max,
      };
    }
    sections[sectionName] = metricMap;
  }

  return {
    version: doc.version,
    sections,
  };
}

export type EditableSpecRow = {
  _key: string;
  section: string;
  metric: string;
  min: string;
  max: string;
};

export type PrepareSpecResult =
  | {
      ok: true;
      spec: {
        version: 1;
        sections: Record<string, Record<string, { min: number | null; max: number | null }>>;
      };
    }
  | { ok: false; error: string };

let nextSpecRow = 0;

export function specRowKey(): string {
  nextSpecRow += 1;
  return `spec-${nextSpecRow}`;
}

function formatBoundEdit(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

export function parseBoundEdit(raw: string): { ok: true; value: number | null } | { ok: false } {
  const t = raw.trim();
  if (!t || t === '∞') return { ok: true, value: null };
  const lower = t.toLowerCase();
  if (
    lower === 'inf' ||
    lower === '+inf' ||
    lower === 'infinity' ||
    lower === '-inf' ||
    lower === '-infinity'
  ) {
    return { ok: true, value: null };
  }
  const n = Number(t);
  if (Number.isNaN(n) || !Number.isFinite(n)) return { ok: false };
  return { ok: true, value: n };
}

export function specToEditableRows(spec: {
  sections?: Record<string, Record<string, { min: number | null; max: number | null }>>;
}): EditableSpecRow[] {
  const rows: EditableSpecRow[] = [];
  const sections = spec.sections ?? {};
  for (const section of Object.keys(sections).sort((a, b) => a.localeCompare(b))) {
    const metrics = sections[section] ?? {};
    for (const metric of Object.keys(metrics).sort((a, b) => a.localeCompare(b))) {
      const bound = metrics[metric];
      rows.push({
        _key: specRowKey(),
        section,
        metric,
        min: formatBoundEdit(bound?.min),
        max: formatBoundEdit(bound?.max),
      });
    }
  }
  return rows;
}

export function prepareSpecFromRows(rows: EditableSpecRow[]): PrepareSpecResult {
  const sections: Record<string, Record<string, { min: number | null; max: number | null }>> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const section = row.section.trim();
    const metric = row.metric.trim();
    if (!section && !metric && !row.min.trim() && !row.max.trim()) continue;
    if (!section || !metric) return { ok: false, error: 'Section 和指标必须同时填写' };
    const id = `${section}\0${metric}`;
    if (seen.has(id)) return { ok: false, error: `重复项：[${section}] ${metric}` };
    seen.add(id);
    const min = parseBoundEdit(row.min);
    const max = parseBoundEdit(row.max);
    if (!min.ok) return { ok: false, error: `无效下限：[${section}] ${metric}` };
    if (!max.ok) return { ok: false, error: `无效上限：[${section}] ${metric}` };
    if (min.value != null && max.value != null && min.value > max.value) {
      return { ok: false, error: `下限大于上限：[${section}] ${metric}` };
    }
    if (!sections[section]) sections[section] = {};
    sections[section][metric] = { min: min.value, max: max.value };
  }
  return { ok: true, spec: { version: 1, sections } };
}

export function suggestSaveAsName(name: string): string {
  const suffix = ' 副本';
  const trimmed = name.trim() || 'Spec 模板';
  const next = trimmed.endsWith(suffix) ? trimmed : `${trimmed}${suffix}`;
  return next.slice(0, 128);
}
