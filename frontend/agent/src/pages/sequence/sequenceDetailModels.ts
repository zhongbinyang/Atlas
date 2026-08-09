import type { ChannelProgress, QueueItem } from './sequenceRunModels';
import {
  buildSequenceChannelDetailSteps,
  formatSequenceElapsed,
  formatSequenceOverall,
} from './sequenceRunModels';

export type DetailStepRow = {
  position: number;
  groupName: string;
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
  limitsSummary: string;
  resultJson: string;
  result: Record<string, unknown> | null;
};

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
    map[key(row, index)] = current ?? '---';
  });
  return map;
}

/** Map step queue positions to group display names; ungrouped → `---`. */
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
  if (!source && !kindText) return '---';
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
    kind: kind.trim() || '---',
  };
}

export function buildDetailStepRows(
  channel: ChannelProgress,
  queue: QueueItem[],
): DetailStepRow[] {
  const groupNames = groupNameByQueuePosition(queue);
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
    return {
      position: step.position,
      groupName: groupNames[step.position] ?? '---',
      name: step.name,
      sourceLabel,
      kind,
      status: step.status,
      elapsedMs: step.elapsedMs,
      ok: typeof result?.ok === 'boolean' ? result.ok : null,
      error: result?.error != null ? String(result.error) : '',
      measured,
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
