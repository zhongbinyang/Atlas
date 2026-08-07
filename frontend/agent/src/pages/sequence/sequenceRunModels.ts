export type QueueItem = {
  position?: number;
  name?: string;
  template_source?: string;
  enabled?: boolean;
  [key: string]: unknown;
};

export type ChannelConfig = {
  channel_index: number;
  name?: string;
  enabled?: boolean;
};

export type ChannelProgress = {
  channel_index: number;
  name: string;
  steps: unknown[];
  overall: string | null;
  current_position?: number | null;
  current_name?: string | null;
  elapsed_ms?: number | null;
  current_step_elapsed_ms?: number | null;
  generation?: number | null;
  synthetic?: boolean;
  running: boolean;
};

export type ChannelCardModel = {
  state: 'idle' | 'running' | 'pass' | 'fail';
  currentGroupName: string;
  currentLabel: string;
  currentName: string;
  currentPosition: number | null;
  completed: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  elapsedMs: number;
  currentElapsedMs: number | null;
};

export function formatSequenceElapsed(rawMilliseconds: unknown): string {
  if (rawMilliseconds == null || !Number.isFinite(Number(rawMilliseconds))) return '—';
  const total = Math.max(0, Math.floor(Number(rawMilliseconds)));
  const milliseconds = total % 1000;
  const totalSeconds = Math.floor(total / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const core =
    `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.` +
    `${String(milliseconds).padStart(3, '0')}`;
  return hours > 0 ? `${String(hours).padStart(2, '0')}:${core}` : core;
}

export function formatSequenceOverall(overall: unknown): string {
  const normalized = String(overall || '').toLowerCase();
  const map: Record<string, string> = {
    pass: '通过',
    ok: '通过',
    fail: '失败',
    failed: '失败',
    error: '错误',
    aborted: '已中止',
    running: '执行中',
    waiting_resource: '等待资源',
    stopped: '失败',
    idle: '待执行',
    pending: '待执行',
  };
  return map[normalized] || (normalized ? String(overall) : '待执行');
}

export function buildSequenceRunPayload(
  templateId: string | number | null | undefined,
  selectedChannelIndexes: number[] | null | undefined,
  explicitChannelIndexes?: number[] | null,
): Record<string, unknown> {
  const channelIndexes = Array.isArray(explicitChannelIndexes)
    ? explicitChannelIndexes.slice()
    : selectedChannelIndexes;
  const payload: Record<string, unknown> = {};
  if (templateId != null) payload.sequence_template_id = templateId;
  if (Array.isArray(channelIndexes)) payload.channel_indexes = channelIndexes.slice();
  return payload;
}

export function pendingSequenceChannelsForOperator(
  enabledChannels: ChannelConfig[],
  selectedIndexes: number[] | null,
): ChannelProgress[] {
  const enabled = Array.isArray(enabledChannels) ? enabledChannels : [];
  if (!enabled.length) {
    return [{ channel_index: 0, name: 'CH0', steps: [], overall: null, running: false, synthetic: true }];
  }
  const selected = Array.isArray(selectedIndexes)
    ? selectedIndexes.reduce<Record<number, boolean>>((map, channelIndex) => {
        map[channelIndex] = true;
        return map;
      }, {})
    : null;
  return enabled
    .filter((channel) => selected == null || !!selected[channel.channel_index])
    .sort((a, b) => Number(a.channel_index) - Number(b.channel_index))
    .map((channel) => ({
      channel_index: channel.channel_index,
      name: channel.name || `CH${channel.channel_index}`,
      steps: [],
      overall: null,
      running: false,
      synthetic: false,
    }));
}

export function sequenceChannelsForDisplay(
  enabledChannels: ChannelConfig[],
  selectedIndexes: number[] | null,
  progress: ChannelProgress[],
): ChannelProgress[] {
  const enabled = enabledChannels.filter((ch) => ch.enabled !== false);
  if (!enabled.length && progress.length) {
    return progress.slice().sort((a, b) => Number(a.channel_index) - Number(b.channel_index));
  }
  const pending = pendingSequenceChannelsForOperator(enabled, selectedIndexes);
  if (!progress.length) return pending;
  const progressByIndex: Record<number, ChannelProgress> = {};
  progress.forEach((channel) => {
    progressByIndex[channel.channel_index] = channel;
  });
  return pending.map((channel) => {
    const live = progressByIndex[channel.channel_index];
    if (!live || !!live.synthetic !== !!channel.synthetic) return channel;
    return live;
  });
}

export function channelProgressFromEnvelope(
  prog: Record<string, unknown> | null | undefined,
  syntheticChannel?: boolean,
): ChannelProgress[] {
  if (!prog) return [];
  if (Array.isArray(prog.channels)) {
    return prog.channels.map((raw) => {
      const ch = (raw ?? {}) as Record<string, unknown>;
      const index = Number(ch.channel_index) || 0;
      return {
        channel_index: index,
        name: String(ch.name || ch.channel_name || `CH${index}`),
        steps: Array.isArray(ch.steps) ? ch.steps : [],
        overall: ch.overall != null ? String(ch.overall) : null,
        current_position: ch.current_position as number | null | undefined,
        current_name: ch.current_name != null ? String(ch.current_name) : null,
        elapsed_ms: ch.elapsed_ms as number | null | undefined,
        current_step_elapsed_ms: ch.current_step_elapsed_ms as number | null | undefined,
        generation:
          ch.generation != null
            ? Number(ch.generation)
            : ch.run_generation != null
              ? Number(ch.run_generation)
              : null,
        synthetic: syntheticChannel === true,
        running: !!ch.running,
      };
    });
  }
  return [
    {
      channel_index: 0,
      name: 'CH0',
      steps: Array.isArray(prog.steps) ? prog.steps : [],
      overall: prog.overall != null ? String(prog.overall) : null,
      current_position: prog.current_position as number | null | undefined,
      current_name: prog.current_name != null ? String(prog.current_name) : null,
      elapsed_ms: prog.elapsed_ms as number | null | undefined,
      current_step_elapsed_ms: prog.current_step_elapsed_ms as number | null | undefined,
      generation:
        prog.generation != null
          ? Number(prog.generation)
          : prog.run_generation != null
            ? Number(prog.run_generation)
            : null,
      synthetic: syntheticChannel === true,
      running: !!prog.running,
    },
  ];
}

export function mergeSequenceChannels(
  current: ChannelProgress[],
  incoming: ChannelProgress[],
): ChannelProgress[] {
  const merged: Record<number, ChannelProgress> = {};
  current.forEach((channel) => {
    merged[Number(channel.channel_index)] = channel;
  });
  incoming.forEach((channel) => {
    const index = Number(channel.channel_index);
    const previous = merged[index];
    if (
      !previous ||
      channel.generation == null ||
      previous.generation == null ||
      Number(channel.generation) >= Number(previous.generation)
    ) {
      merged[index] = channel;
    }
  });
  return Object.keys(merged)
    .map((index) => merged[Number(index)])
    .sort((left, right) => Number(left.channel_index) - Number(right.channel_index));
}

export function sequenceOverallFromChannels(channels: ChannelProgress[]): string | null {
  if (channels.some((channel) => !!channel.running)) return 'running';
  let passed = false;
  for (const channel of channels) {
    const overall = String(channel.overall || '').toLowerCase();
    if (['fail', 'failed', 'error', 'aborted', 'stopped'].includes(overall)) return 'fail';
    if (overall === 'pass' || overall === 'ok') passed = true;
  }
  return passed ? 'pass' : null;
}

export function shouldPollSequenceProgress(
  channels: ChannelProgress[],
  pendingStarts: Record<number, boolean>,
): boolean {
  return channels.some((channel) => !!channel.running) || Object.keys(pendingStarts).length > 0;
}

function buildSequencePositionGroupMap(queue: QueueItem[]) {
  const map: Record<number, { name: string; enabled: boolean; header: boolean }> = {};
  let current = { name: '未分组', enabled: true, header: false };
  (Array.isArray(queue) ? queue : []).forEach((item, index) => {
    const row = item || {};
    const position = row.position != null ? Number(row.position) : index;
    if (row.template_source === 'group') {
      current = {
        name: String(row.name || '未命名组'),
        enabled: row.enabled !== false,
        header: true,
      };
      map[position] = current;
      return;
    }
    map[position] = { name: current.name, enabled: current.enabled, header: false };
  });
  return map;
}

export function buildSequenceChannelCardModel(
  channel: ChannelProgress,
  queue: QueueItem[],
): ChannelCardModel {
  const sourceQueue = Array.isArray(queue) ? queue : [];
  const rawSteps = Array.isArray(channel.steps) ? channel.steps : [];
  const positionGroups = buildSequencePositionGroupMap(sourceQueue);
  const groupPositions: Record<number, boolean> = {};
  const totalPositions: Record<number, boolean> = {};
  for (let i = 0; i < sourceQueue.length; i++) {
    const item = sourceQueue[i] || {};
    const position = item.position != null ? Number(item.position) : i;
    if (item.template_source === 'group') groupPositions[position] = true;
    else totalPositions[position] = true;
  }
  const steps = rawSteps.filter((step, index) => {
    const row = (step || {}) as Record<string, unknown>;
    const position = row.position != null ? Number(row.position) : index;
    if (groupPositions[position]) return false;
    totalPositions[position] = true;
    return true;
  });
  const total = Object.keys(totalPositions).length;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let completed = 0;
  for (const step of steps) {
    const status = String(((step || {}) as Record<string, unknown>).status || '').toLowerCase();
    if (status === 'pass' || status === 'ok') passed += 1;
    else if (status === 'skipped') skipped += 1;
    else if (['fail', 'failed', 'error', 'aborted', 'stopped'].includes(status)) failed += 1;
    if (['pass', 'ok', 'skipped', 'fail', 'failed', 'error', 'aborted', 'stopped'].includes(status)) {
      completed += 1;
    }
  }
  const overall = String(channel.overall || '').toLowerCase();
  let state: ChannelCardModel['state'] = 'idle';
  if (channel.running || overall === 'running' || overall === 'waiting_resource') state = 'running';
  else if (overall === 'pass' || overall === 'ok') state = 'pass';
  else if (['fail', 'failed', 'error', 'aborted', 'stopped'].includes(overall)) state = 'fail';

  let currentPosition: number | null = null;
  let currentGroupName = '—';
  let currentLabel = '当前状态';
  let currentName = '等待运行';
  let currentPositionIsGroup = false;
  if (state === 'running' && channel.current_position != null) {
    currentPosition = Number(channel.current_position);
    const currentGroup = positionGroups[currentPosition];
    currentPositionIsGroup = !!(currentGroup && currentGroup.header);
    currentGroupName = currentGroup ? currentGroup.name : '—';
    if (currentPositionIsGroup) {
      currentPosition = null;
      currentName = '准备下一步';
    } else {
      currentLabel = `当前步骤 ${String(Number(currentPosition) + 1).padStart(2, '0')}`;
      currentName = channel.current_name || '准备下一步';
    }
  } else if (state === 'pass' || state === 'fail') {
    const terminalStatuses: Record<string, boolean> = {
      pass: true,
      ok: true,
      skipped: true,
      fail: true,
      failed: true,
      error: true,
      aborted: true,
      stopped: true,
    };
    for (let i = rawSteps.length - 1; i >= 0; i--) {
      const step = (rawSteps[i] || {}) as Record<string, unknown>;
      const position = step.position != null ? Number(step.position) : i;
      const group = positionGroups[position];
      const status = String(step.status || '').toLowerCase();
      if (!terminalStatuses[status] || !group || group.header) continue;
      currentPosition = position;
      currentGroupName = group.name;
      currentLabel = `最后步骤 ${String(Number(position) + 1).padStart(2, '0')}`;
      currentName =
        String(step.name || '') ||
        String(
          sourceQueue.find((item, index) => {
            const queueItem = item || {};
            return (queueItem.position != null ? Number(queueItem.position) : index) === position;
          })?.name || `步骤 ${Number(position) + 1}`,
        );
      break;
    }
  }

  return {
    state,
    currentGroupName,
    currentLabel,
    currentName,
    currentPosition,
    completed,
    total,
    passed,
    failed,
    skipped,
    elapsedMs: Number(channel.elapsed_ms) || 0,
    currentElapsedMs:
      channel.current_step_elapsed_ms != null && !currentPositionIsGroup
        ? Number(channel.current_step_elapsed_ms)
        : null,
  };
}

export function buildSequenceChannelDetailSteps(channel: ChannelProgress, queue: QueueItem[]) {
  const sourceQueue = Array.isArray(queue) ? queue : [];
  const actualSteps = Array.isArray(channel.steps) ? channel.steps : [];
  const byPosition: Record<number, Record<string, unknown>> = {};
  const groupPositions: Record<number, boolean> = {};
  for (let i = 0; i < sourceQueue.length; i++) {
    const item = sourceQueue[i] || {};
    if (item.template_source !== 'group') continue;
    groupPositions[item.position != null ? Number(item.position) : i] = true;
  }
  for (let i = 0; i < actualSteps.length; i++) {
    const result = (actualSteps[i] || {}) as Record<string, unknown>;
    const position = result.position != null ? Number(result.position) : i;
    byPosition[position] = result;
  }
  const detailSteps: Array<{
    position: number;
    name: string;
    status: string;
    elapsedMs: number | null;
    result: Record<string, unknown> | null;
  }> = [];
  for (let i = 0; i < sourceQueue.length; i++) {
    const item = sourceQueue[i] || {};
    const position = item.position != null ? Number(item.position) : i;
    if (item.template_source === 'group') {
      delete byPosition[position];
      continue;
    }
    const result = byPosition[position] || null;
    let status = result && result.status ? String(result.status).toLowerCase() : 'pending';
    if (!result && channel.current_position === position && channel.running) status = 'running';
    detailSteps.push({
      position,
      name: String((result && result.name) || item.name || `步骤 ${position + 1}`),
      status,
      elapsedMs: result && result.elapsed_ms != null ? Number(result.elapsed_ms) : null,
      result,
    });
    delete byPosition[position];
  }
  Object.keys(byPosition)
    .map(Number)
    .sort((a, b) => a - b)
    .forEach((position) => {
      if (groupPositions[position]) return;
      const result = byPosition[position] || {};
      detailSteps.push({
        position: result.position != null ? Number(result.position) : position,
        name: String(result.name || `步骤 ${position + 1}`),
        status: result.status ? String(result.status).toLowerCase() : 'pending',
        elapsedMs: result.elapsed_ms != null ? Number(result.elapsed_ms) : null,
        result,
      });
    });
  return detailSteps;
}

export function sequenceRunQueueItems(queue: QueueItem[]): QueueItem[] {
  return queue.filter((item) => item && item.template_source !== 'group');
}
