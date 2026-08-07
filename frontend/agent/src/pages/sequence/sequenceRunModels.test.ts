import { describe, expect, it } from 'vitest';
import {
  buildSequenceChannelCardModel,
  buildSequenceRunPayload,
  formatSequenceElapsed,
  formatSequenceOverall,
  mergeSequenceChannels,
  pendingSequenceChannelsForOperator,
  sequenceChannelsForDisplay,
  shouldPollSequenceProgress,
} from './sequenceRunModels';

describe('buildSequenceRunPayload', () => {
  it('puts a single channel index for card runs', () => {
    expect(buildSequenceRunPayload(null, [0, 1], [2])).toEqual({ channel_indexes: [2] });
  });

  it('keeps selected channels for top-level runs', () => {
    expect(buildSequenceRunPayload(9, [0, 1])).toEqual({
      sequence_template_id: 9,
      channel_indexes: [0, 1],
    });
  });
});

describe('pendingSequenceChannelsForOperator', () => {
  it('uses synthetic CH0 when no channels configured', () => {
    expect(pendingSequenceChannelsForOperator([], null)).toEqual([
      { channel_index: 0, name: 'CH0', steps: [], overall: null, running: false, synthetic: true },
    ]);
  });
});

describe('sequenceChannelsForDisplay', () => {
  it('merges live progress onto pending cards', () => {
    const cards = sequenceChannelsForDisplay(
      [{ channel_index: 1, name: 'A', enabled: true }],
      null,
      [
        {
          channel_index: 1,
          name: 'A',
          steps: [{ status: 'pass' }],
          overall: 'pass',
          running: false,
          synthetic: false,
        },
      ],
    );
    expect(cards[0].overall).toBe('pass');
    expect(cards[0].steps).toHaveLength(1);
  });
});

describe('card model and formatting', () => {
  it('formats elapsed and overall labels', () => {
    expect(formatSequenceElapsed(65001)).toBe('01:05.001');
    expect(formatSequenceOverall('running')).toBe('执行中');
    expect(formatSequenceOverall(null)).toBe('待执行');
  });

  it('builds idle card totals from queue length', () => {
    const model = buildSequenceChannelCardModel(
      { channel_index: 0, name: 'CH0', steps: [], overall: null, running: false },
      [{ name: 'A' }, { name: 'B' }],
    );
    expect(model).toMatchObject({
      state: 'idle',
      total: 2,
      completed: 0,
      currentName: '等待运行',
    });
  });
});

describe('progress helpers', () => {
  it('merges by generation and decides polling', () => {
    const merged = mergeSequenceChannels(
      [{ channel_index: 0, name: 'CH0', steps: [], overall: null, running: true, generation: 1 }],
      [{ channel_index: 0, name: 'CH0', steps: [], overall: 'pass', running: false, generation: 2 }],
    );
    expect(merged[0].overall).toBe('pass');
    expect(shouldPollSequenceProgress(merged, {})).toBe(false);
    expect(shouldPollSequenceProgress(merged, { 0: true })).toBe(true);
  });
});
