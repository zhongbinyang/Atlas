import { EMPTY_PLACEHOLDER } from '@shared/uiCopy';
import type { ChannelProgress, QueueItem } from './sequenceRunModels';
import {
  buildSequenceChannelDetailSteps,
  formatSequenceElapsed,
  formatSequenceOverall,
} from './sequenceRunModels';

export type DetailStepRow = {
  position: number;
  groupName: string;
  specSection: string;
  name: string;
  /** Display label: VI / 通用 */
  sourceLabel: string;
  /** Raw kind: labview / version / delay / rest / … */
  kind: string;
  status: string;
  elapsedMs: number | null;
  ok: boolean | null;
  error: string;
  measured: Record<string, unknown>;
  limitCells: LimitValueCells;
  limitsSummary: string;
  resultJson: string;
  result: Record<string, unknown> | null;
};

export type LimitValueCells = {
  value: string;
  min: string;
  max: string;
  unit: string;
};

export type ParsedLimitRule = {
  output: string;
  min: string;
  max: string;
  unit: string;
  expect: string;
};

export type SpecTemplateLike = {
  spec?: {
    sections?: Record<string, Record<string, { min?: number | null; max?: number | null }>>;
  };
};

function formatLimitBound(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return String(value).trim();
}

export function emptyLimitValueCells(): LimitValueCells {
  return {
    value: EMPTY_PLACEHOLDER,
    min: EMPTY_PLACEHOLDER,
    max: EMPTY_PLACEHOLDER,
    unit: EMPTY_PLACEHOLDER,
  };
}

export function parseLimitRules(limits: unknown): ParsedLimitRule[] {
  if (!Array.isArray(limits)) return [];
  return limits
    .map((item) => {
      const rule = asRecord(item);
      return {
        output: String(rule.output ?? rule.name ?? '').trim(),
        min: formatLimitBound(rule.min),
        max: formatLimitBound(rule.max),
        unit: rule.unit != null ? String(rule.unit).trim() : '',
        expect: formatLimitBound(rule.expect ?? rule.expected),
      };
    })
    .filter((rule) => rule.output || rule.min || rule.max || rule.expect);
}

export function limitValueCellsFromRule(
  rule: ParsedLimitRule | undefined,
  measured?: Record<string, unknown>,
): LimitValueCells {
  if (!rule) return emptyLimitValueCells();
  let value = '';
  if (measured) {
    if (rule.output && measured[rule.output] != null) {
      value = String(measured[rule.output]);
    } else {
      const keys = Object.keys(measured);
      if (keys.length === 1) {
        value = String(measured[keys[0]!]);
      } else if (keys.length > 0) {
        value = String(measured[keys[0]!]);
      }
    }
  }
  if (!value && rule.expect) value = rule.expect;
  return {
    value: value || EMPTY_PLACEHOLDER,
    min: rule.min || EMPTY_PLACEHOLDER,
    max: rule.max || EMPTY_PLACEHOLDER,
    unit: rule.unit || EMPTY_PLACEHOLDER,
  };
}

export function limitValueCellsFromLimits(
  limits: unknown,
  measured?: Record<string, unknown>,
): LimitValueCells {
  const rules = parseLimitRules(limits);
  if (rules.length) {
    return limitValueCellsFromRule(rules[0], measured);
  }
  if (measured) {
    const keys = Object.keys(measured);
    if (keys.length) {
      return {
        value: String(measured[keys[0]!]),
        min: EMPTY_PLACEHOLDER,
        max: EMPTY_PLACEHOLDER,
        unit: EMPTY_PLACEHOLDER,
      };
    }
  }
  return emptyLimitValueCells();
}

export function resolveStepLimitPreview(
  item: Record<string, unknown>,
  specTemplateDetails: Record<number, SpecTemplateLike>,
): LimitValueCells {
  const handLimits = parseLimitRules(item.limits);
  if (handLimits.length) {
    return limitValueCellsFromRule(handLimits[0]);
  }

  const templateId = toSpecTemplateId(item.spec_template_id);
  const section = String(item.spec_section ?? '').trim();
  if (templateId == null || !section || section.includes('${')) {
    return emptyLimitValueCells();
  }

  const sections = specTemplateDetails[templateId]?.spec?.sections;
  const sectionMetrics = sections?.[section];
  if (!sectionMetrics) return emptyLimitValueCells();

  const selectedMetrics = normalizeStringArray(item.spec_metrics);
  const metricNames = selectedMetrics.length
    ? selectedMetrics
    : Object.keys(sectionMetrics).sort((a, b) => a.localeCompare(b));
  const metric = metricNames[0];
  if (!metric) return emptyLimitValueCells();

  const bound = sectionMetrics[metric];
  if (!bound) return emptyLimitValueCells();

  return {
    value: EMPTY_PLACEHOLDER,
    min: bound.min != null ? String(bound.min) : EMPTY_PLACEHOLDER,
    max: bound.max != null ? String(bound.max) : EMPTY_PLACEHOLDER,
    unit: EMPTY_PLACEHOLDER,
  };
}

export const LIMIT_VALUE_COLUMN_DEFS = [
  { key: 'value', title: '值', width: 72 },
  { key: 'min', title: '下限', width: 64 },
  { key: 'max', title: '上限', width: 64 },
  { key: 'unit', title: '单位', width: 56 },
] as const;

export const LIMIT_VALUE_COLUMNS_WIDTH = LIMIT_VALUE_COLUMN_DEFS.reduce(
  (sum, col) => sum + col.width,
  0,
);

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function countHandLimits(limits: unknown): number {
  return Array.isArray(limits) ? limits.length : 0;
}

export function sectionMetricKeys(
  sections: Record<string, Record<string, unknown>> | undefined,
  section: string,
): string[] {
  if (!sections || !section.trim()) return [];
  const metrics = sections[section.trim()];
  if (!metrics || typeof metrics !== 'object') return [];
  return Object.keys(metrics).sort((a, b) => a.localeCompare(b));
}

export function formatStepSpecSummary(
  item: Record<string, unknown>,
  sectionMetricCount?: number | null,
): string {
  const templateRaw = item.spec_template_id;
  const templateId =
    templateRaw == null || templateRaw === '' ? null : Number(templateRaw);
  if (templateId != null && Number.isFinite(templateId)) {
    const section = String(item.spec_section ?? '').trim() || '—';
    const selectedMetrics = normalizeStringArray(item.spec_metrics);
    if (selectedMetrics.length) {
      return `模板#${templateId}·${section}·${selectedMetrics.length}项`;
    }
    if (sectionMetricCount != null && sectionMetricCount > 0) {
      return `模板#${templateId}·${section}·${sectionMetricCount}项`;
    }
    return `模板#${templateId}·${section}·全部`;
  }
  const handCount = countHandLimits(item.limits);
  if (handCount > 0) return `手填 ${handCount}项`;
  return '未设置';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

export function formatLimitsSummary(limits: unknown): string {
  if (limits == null) return '—';
  if (!Array.isArray(limits) || !limits.length) return '—';
  return limits
    .map((item) => {
      const rule = asRecord(item);
      const output = String(rule.output ?? rule.name ?? '');
      const unit = rule.unit != null ? String(rule.unit) : '';
      const min = rule.min != null ? String(rule.min) : '';
      const max = rule.max != null ? String(rule.max) : '';
      const expected = rule.expected != null ? String(rule.expected) : '';
      if (expected) return `${output}=${expected}${unit ? ` ${unit}` : ''}`.trim();
      if (min || max) return `${output}[${min},${max}]${unit ? ` ${unit}` : ''}`.trim();
      return output || JSON.stringify(item);
    })
    .filter(Boolean)
    .join(' · ');
}

export function measuredObject(raw: unknown): Record<string, unknown> {
  const fromMeasured = asRecord(raw);
  if (Object.keys(fromMeasured).length) return fromMeasured;
  return {};
}

export function collectMeasuredKeys(rows: DetailStepRow[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    Object.keys(row.measured).forEach((key) => keys.add(key));
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

function resolveGroupSpecSections(queue: QueueItem[], key: (item: QueueItem, index: number) => number) {
  const map: Record<number, string> = {};
  let current = '';
  (Array.isArray(queue) ? queue : []).forEach((item, index) => {
    const row = item || {};
    if (row.template_source === 'group') {
      current = String(row.spec_section ?? '').trim();
      map[key(row, index)] = current;
      return;
    }
    const own = String(row.spec_section ?? '').trim();
    map[key(row, index)] = current || own || EMPTY_PLACEHOLDER;
  });
  return map;
}

/** Map step queue positions to Spec section labels for display. */
export function groupSpecSectionByQueuePosition(queue: QueueItem[]): Record<number, string> {
  return resolveGroupSpecSections(queue, (row, index) =>
    row.position != null ? Number(row.position) : index,
  );
}

function resolveGroupNames(queue: QueueItem[], key: (item: QueueItem, index: number) => number) {
  const map: Record<number, string> = {};
  let current: string | null = null;
  (Array.isArray(queue) ? queue : []).forEach((item, index) => {
    const row = item || {};
    if (row.template_source === 'group') {
      current = String(row.name || '未命名组').trim() || '未命名组';
      map[key(row, index)] = current;
      return;
    }
    map[key(row, index)] = current ?? EMPTY_PLACEHOLDER;
  });
  return map;
}

/** Map step queue positions to group display names; ungrouped → em dash. */
export function groupNameByQueuePosition(queue: QueueItem[]): Record<number, string> {
  return resolveGroupNames(queue, (row, index) =>
    row.position != null ? Number(row.position) : index,
  );
}

/** Map queue array indexes to group display names (for edit table rows). */
export function groupNameByQueueIndex(queue: QueueItem[]): Record<number, string> {
  return resolveGroupNames(queue, (_, index) => index);
}

export type QueueStepRow = { item: QueueItem; queueIndex: number };

/** Queue rows shown in the edit table (group markers are hidden). */
export function listQueueStepRows(queue: QueueItem[]): QueueStepRow[] {
  return (Array.isArray(queue) ? queue : [])
    .map((item, queueIndex) => ({ item, queueIndex }))
    .filter(({ item }) => item?.template_source !== 'group');
}

export function findGroupIndexForStep(queue: QueueItem[], stepIndex: number): number | null {
  for (let i = stepIndex - 1; i >= 0; i--) {
    if (queue[i]?.template_source === 'group') return i;
  }
  return null;
}

export type GroupSpecBinding = {
  spec_template_id: number | null;
  spec_section: string;
};

const toSpecTemplateId = (value: unknown): number | null => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Map queue array indexes to the active group's Spec binding (group marker or step). */
export function groupSpecByQueueIndex(queue: QueueItem[]): Record<number, GroupSpecBinding> {
  const map: Record<number, GroupSpecBinding> = {};
  let current: GroupSpecBinding | null = null;
  (Array.isArray(queue) ? queue : []).forEach((item, index) => {
    const row = item || {};
    if (row.template_source === 'group') {
      const binding: GroupSpecBinding = {
        spec_template_id: toSpecTemplateId(row.spec_template_id),
        spec_section: String(row.spec_section ?? '').trim(),
      };
      current = binding;
      map[index] = binding;
      return;
    }
    map[index] = current ?? { spec_template_id: null, spec_section: '' };
  });
  return map;
}

/** Effective Spec section label for a step row (group binding or step's own). */
export function effectiveSpecSectionForStep(queue: QueueItem[], stepIndex: number): string {
  const groupIndex = findGroupIndexForStep(queue, stepIndex);
  if (groupIndex != null) {
    return String(queue[groupIndex]?.spec_section ?? '').trim();
  }
  return String(queue[stepIndex]?.spec_section ?? '').trim();
}

/** Copy group Spec binding onto all descendant steps until the next group marker. */
export function applyGroupSpecToDescendants(queue: QueueItem[], groupIndex: number): QueueItem[] {
  const group = queue[groupIndex];
  if (!group || group.template_source !== 'group') return queue;
  const patch: Pick<QueueItem, 'spec_template_id' | 'spec_section' | 'spec_metrics'> = {
    spec_template_id: group.spec_template_id ?? null,
    spec_section: String(group.spec_section ?? '').trim(),
    spec_metrics: [],
  };
  const next = queue.slice();
  for (let i = groupIndex + 1; i < next.length; i++) {
    if (next[i]?.template_source === 'group') break;
    next[i] = { ...next[i], ...patch };
  }
  return next;
}

export function isFirstStepInGroup(queue: QueueItem[], stepIndex: number): boolean {
  const groupIndex = findGroupIndexForStep(queue, stepIndex);
  if (groupIndex == null) return false;
  for (let i = groupIndex + 1; i < queue.length; i++) {
    if (queue[i]?.template_source === 'group') return false;
    return i === stepIndex;
  }
  return false;
}

export function formatStepSourceLabel(templateSource: unknown, kind: unknown): string {
  const source = String(templateSource || '').toLowerCase();
  const kindText = String(kind || '').toLowerCase();
  if (source === 'general' || ['delay', 'version', 'rest'].includes(kindText)) return '通用';
  if (source === 'labview' || kindText === 'labview') return 'VI';
  if (!source && !kindText) return EMPTY_PLACEHOLDER;
  return 'VI';
}

function queueMetaByPosition(queue: QueueItem[]): Record<number, { source: string; kind: string }> {
  const map: Record<number, { source: string; kind: string }> = {};
  (Array.isArray(queue) ? queue : []).forEach((item, index) => {
    const row = item || {};
    if (row.template_source === 'group') return;
    const position = row.position != null ? Number(row.position) : index;
    map[position] = {
      source: String(row.template_source || ''),
      kind: String(row.kind || ''),
    };
  });
  return map;
}

export function resolveStepSourceAndKind(
  position: number,
  queueMeta: Record<number, { source: string; kind: string }>,
  result: Record<string, unknown> | null,
): { sourceLabel: string; kind: string } {
  const fromQueue = queueMeta[position];
  const source =
    (fromQueue?.source && fromQueue.source !== 'group' ? fromQueue.source : '') ||
    String(result?.template_source || '');
  const kind = (fromQueue?.kind ? fromQueue.kind : '') || String(result?.kind || '');
  const sourceLabel = formatStepSourceLabel(source, kind);
  return {
    sourceLabel,
    kind: kind.trim() || EMPTY_PLACEHOLDER,
  };
}

export function buildDetailStepRows(
  channel: ChannelProgress,
  queue: QueueItem[],
): DetailStepRow[] {
  const groupNames = groupNameByQueuePosition(queue);
  const specSections = groupSpecSectionByQueuePosition(queue);
  const queueMeta = queueMetaByPosition(queue);
  return buildSequenceChannelDetailSteps(channel, queue).map((step) => {
    const result = step.result;
    const measured = measuredObject(result?.measured);
    let resultJson = '';
    if (result?.result != null) {
      try {
        resultJson = JSON.stringify(result.result);
      } catch {
        resultJson = String(result.result);
      }
    }
    const { sourceLabel, kind } = resolveStepSourceAndKind(step.position, queueMeta, result);
    const limitCells = limitValueCellsFromLimits(result?.limits, measured);
    return {
      position: step.position,
      groupName: groupNames[step.position] ?? EMPTY_PLACEHOLDER,
      specSection: specSections[step.position] ?? EMPTY_PLACEHOLDER,
      name: step.name,
      sourceLabel,
      kind,
      status: step.status,
      elapsedMs: step.elapsedMs,
      ok: typeof result?.ok === 'boolean' ? result.ok : null,
      error: result?.error != null ? String(result.error) : '',
      measured,
      limitCells,
      limitsSummary: formatLimitsSummary(result?.limits),
      resultJson,
      result,
    };
  });
}

export function buildChannelLogText(
  channel: ChannelProgress,
  rows: DetailStepRow[],
  logDir?: string | null,
): string {
  const lines: string[] = [];
  const name = channel.name || `CH${channel.channel_index}`;
  lines.push(`[channel] ${name} (#${channel.channel_index})`);
  lines.push(
    `[status] ${channel.running ? 'running' : formatSequenceOverall(channel.overall)} · elapsed ${formatSequenceElapsed(channel.elapsed_ms)}`,
  );
  if (channel.current_name) {
    lines.push(
      `[current] ${channel.current_name}` +
        (channel.current_position != null ? ` @#${Number(channel.current_position) + 1}` : '') +
        (channel.current_step_elapsed_ms != null
          ? ` · ${formatSequenceElapsed(channel.current_step_elapsed_ms)}`
          : ''),
    );
  }
  const logRoot = logDir ? `${logDir}\\sequence_runs` : '(未知日志目录)\\sequence_runs';
  lines.push(`[log_dir] ${logRoot}`);
  lines.push('--- steps ---');
  for (const row of rows) {
    const status =
      row.status === 'pending' ? 'pending' : formatSequenceOverall(row.status);
    const elapsed = formatSequenceElapsed(row.elapsedMs);
    lines.push(
      `#${String(row.position + 1).padStart(2, '0')} ${row.name} · ${status} · ${elapsed}` +
        (row.ok == null ? '' : row.ok ? ' · ok' : ' · fail') +
        (row.error ? ` · error=${row.error}` : ''),
    );
    const measuredKeys = Object.keys(row.measured);
    if (measuredKeys.length) {
      lines.push(
        `    measured: ${measuredKeys.map((k) => `${k}=${String(row.measured[k])}`).join(', ')}`,
      );
    }
    if (row.limitsSummary !== '—') lines.push(`    limits: ${row.limitsSummary}`);
    if (row.resultJson) lines.push(`    result: ${row.resultJson}`);
  }
  return lines.join('\n');
}
