import { describe, expect, it } from 'vitest';
import {
  buildChannelLogText,
  buildDetailStepRows,
  collectMeasuredKeys,
  findGroupIndexForStep,
  formatLimitsSummary,
  groupNameByQueueIndex,
  isFirstStepInGroup,
  listQueueStepRows,
} from './sequenceDetailModels';
import type { ChannelProgress, QueueItem } from './sequenceRunModels';

describe('sequenceDetailModels', () => {
  it('formats limits and expands measured columns', () => {
    expect(formatLimitsSummary([{ output: 'Power_dBm', min: -5, max: 3, unit: 'dBm' }])).toBe(
      'Power_dBm[-5,3] dBm',
    );

    const queue: QueueItem[] = [
      { position: 0, name: 'Eye', template_source: 'labview', kind: 'labview' },
      { position: 1, name: '光模块', template_source: 'group' },
      { position: 2, name: 'Power', template_source: 'labview', kind: 'labview' },
      { position: 3, name: 'AgentVer', template_source: 'general', kind: 'version' },
    ];
    const channel: ChannelProgress = {
      channel_index: 0,
      name: 'CH0',
      steps: [
        {
          position: 0,
          name: 'Eye',
          status: 'pass',
          ok: true,
          elapsed_ms: 12,
          measured: { ER_dB: 8.1 },
          limits: [{ output: 'ER_dB', min: 7, max: 12 }],
        },
        {
          position: 2,
          name: 'Power',
          status: 'fail',
          ok: false,
          elapsed_ms: 20,
          measured: { Power_dBm: 4.2 },
          error: 'out of range',
        },
        {
          position: 3,
          name: 'AgentVer',
          status: 'pass',
          ok: true,
          elapsed_ms: 5,
          kind: 'version',
          template_source: 'general',
        },
      ],
      overall: 'fail',
      running: false,
    };

    const rows = buildDetailStepRows(channel, queue);
    expect(rows[0].groupName).toBe('---');
    expect(rows[0].sourceLabel).toBe('VI');
    expect(rows[0].kind).toBe('labview');
    expect(rows[1].groupName).toBe('光模块');
    expect(rows[2].sourceLabel).toBe('通用');
    expect(rows[2].kind).toBe('version');
    expect(collectMeasuredKeys(rows)).toEqual(['ER_dB', 'Power_dBm']);
    expect(rows[1].error).toBe('out of range');
    expect(buildChannelLogText(channel, rows, 'D:\\logs')).toContain('Power_dBm=4.2');
  });

  it('maps group names by queue array index', () => {
    const queue: QueueItem[] = [
      { name: 'Eye', template_source: 'labview' },
      { name: '光模块', template_source: 'group' },
      { name: 'Power', template_source: 'labview' },
      { name: 'AgentVer', template_source: 'general' },
    ];
    expect(groupNameByQueueIndex(queue)).toEqual({
      0: '---',
      1: '光模块',
      2: '光模块',
      3: '光模块',
    });
  });

  it('lists only runnable steps and resolves group markers', () => {
    const queue: QueueItem[] = [
      { name: 'Eye', template_source: 'labview' },
      { name: 'HT-FMT', template_source: 'group' },
      { name: 'Add02', template_source: 'labview' },
      { name: 'delay', template_source: 'general', kind: 'delay' },
    ];
    expect(listQueueStepRows(queue).map((row) => row.item.name)).toEqual(['Eye', 'Add02', 'delay']);
    expect(isFirstStepInGroup(queue, 2)).toBe(true);
    expect(isFirstStepInGroup(queue, 3)).toBe(false);
    expect(findGroupIndexForStep(queue, 3)).toBe(1);
  });
});
