import { describe, expect, it } from 'vitest';
import { parseViInputValue } from './ViPage';

describe('parseViInputValue', () => {
  it('preserves JSON values and converts scalar values for VI runs', () => {
    expect(parseViInputValue('[1, 2]', true)).toEqual([1, 2]);
    expect(parseViInputValue('12.5', false)).toBe(12.5);
    expect(parseViInputValue('false', false)).toBe(false);
    expect(parseViInputValue('', false)).toBeNull();
    expect(parseViInputValue('${Serial}', false)).toBe('${Serial}');
  });

  it('rejects malformed JSON input', () => {
    expect(() => parseViInputValue('{not json}', true)).toThrow('JSON 无效');
  });
});
