import { describe, expect, it } from 'vitest';
import { parseViInputsJson } from './ViPage';

describe('parseViInputsJson', () => {
  it('parses a VI inputs array', () => {
    expect(parseViInputsJson('[{"name":"a","className":"String","value":"x"}]')).toEqual([
      { name: 'a', className: 'String', value: 'x' },
    ]);
    expect(parseViInputsJson('')).toEqual([]);
  });

  it('rejects malformed or non-array JSON', () => {
    expect(() => parseViInputsJson('{not json}')).toThrow('入参 JSON 无效');
    expect(() => parseViInputsJson('{"name":"a"}')).toThrow('入参 JSON 必须是数组');
  });
});
