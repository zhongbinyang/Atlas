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
