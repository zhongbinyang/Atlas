import { describe, expect, it, beforeEach } from 'vitest';
import {
  ACTIVE_SEQUENCE_STORAGE_KEY,
  bindActiveSequence,
  buildActiveSequenceSummary,
  clearActiveSequenceBinding,
  countRunQueueSteps,
  markActiveSequenceDirty,
  readActiveSequenceBinding,
} from './sequenceActive';

const memory = new Map<string, string>();

const localStorageMock = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) => {
    memory.set(key, String(value));
  },
  removeItem: (key: string) => {
    memory.delete(key);
  },
  clear: () => memory.clear(),
};

Object.defineProperty(globalThis, 'window', {
  value: { localStorage: localStorageMock },
  configurable: true,
});
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  configurable: true,
});

describe('sequenceActive', () => {
  beforeEach(() => {
    memory.clear();
  });

  it('binds, marks dirty, and clears localStorage', () => {
    expect(readActiveSequenceBinding()).toBeNull();
    bindActiveSequence(12, 'PowerCycle');
    expect(readActiveSequenceBinding()).toEqual({ id: 12, name: 'PowerCycle', dirty: false });
    expect(localStorageMock.getItem(ACTIVE_SEQUENCE_STORAGE_KEY)).toContain('PowerCycle');
    markActiveSequenceDirty();
    expect(readActiveSequenceBinding()?.dirty).toBe(true);
    clearActiveSequenceBinding();
    expect(readActiveSequenceBinding()).toBeNull();
  });

  it('counts non-group queue steps and formats summary', () => {
    expect(
      countRunQueueSteps([
        { template_source: 'group' },
        { template_source: 'labview' },
        { template_source: 'general' },
      ]),
    ).toBe(2);

    expect(buildActiveSequenceSummary(3, null).title).toBe('当前激活：执行顺序草稿 · 3 步');
    expect(buildActiveSequenceSummary(5, { id: 9, name: 'Smoke', dirty: true }).title).toBe(
      '当前激活：Smoke（#9）· 5 步',
    );
    expect(buildActiveSequenceSummary(5, { id: 9, name: 'Smoke', dirty: true }).dirty).toBe(true);
  });
});
