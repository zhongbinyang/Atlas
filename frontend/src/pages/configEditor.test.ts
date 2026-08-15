import { describe, expect, it } from 'vitest';
import {
  isSystemVarName,
  normalizeArrayExpandMode,
  normalizeChannels,
  normalizeVariables,
  parseOverlayText,
  prepareChannelsForSave,
  prepareVariablesForSave,
} from './configEditor';

describe('configEditor', () => {
  it('treats Hostname and IP as system variables', () => {
    expect(isSystemVarName('Hostname')).toBe(true);
    expect(isSystemVarName('IP')).toBe(true);
    expect(isSystemVarName('SN_PREFIX')).toBe(false);
  });

  it('normalizes variables from unknown settings payload', () => {
    const rows = normalizeVariables({
      variables: [
        { name: ' SN_PREFIX ', value: 'A', description: 'prefix' },
        { name: 1, value: null },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: 'SN_PREFIX', value: 'A', description: 'prefix' });
    expect(rows[0]._key).toBeTruthy();
    expect(rows[1]).toMatchObject({ name: '1', value: '', description: '' });
  });

  it('rejects empty, duplicate, and invalid variable names on save', () => {
    expect(
      prepareVariablesForSave([
        { _key: '1', name: 'Good', value: '1', description: '' },
        { _key: '2', name: '  ', value: 'x', description: '' },
      ]),
    ).toEqual({ ok: false, error: '变量名不能为空' });

    expect(
      prepareVariablesForSave([
        { _key: '1', name: 'Dup', value: '1', description: '' },
        { _key: '2', name: 'Dup', value: '2', description: '' },
      ]),
    ).toEqual({ ok: false, error: '重复变量：Dup' });

    expect(
      prepareVariablesForSave([{ _key: '1', name: '1bad', value: '', description: '' }]),
    ).toEqual({ ok: false, error: '无效变量名：1bad' });
  });

  it('keeps Hostname and IP when saving variables', () => {
    expect(
      prepareVariablesForSave([
        { _key: '1', name: 'Hostname', value: 'old', description: '' },
        { _key: '2', name: 'SN_PREFIX', value: 'A', description: 'p' },
      ]),
    ).toEqual({
      ok: true,
      variables: [
        { name: 'Hostname', value: 'old', description: '' },
        { name: 'SN_PREFIX', value: 'A', description: 'p' },
      ],
    });
  });

  it('normalizes array expand mode', () => {
    expect(normalizeArrayExpandMode('json')).toBe('json');
    expect(normalizeArrayExpandMode('other')).toBe('semicolon');
    expect(normalizeArrayExpandMode(undefined)).toBe('semicolon');
  });

  it('parses overlay JSON as a string-valued object', () => {
    expect(parseOverlayText('')).toEqual({ ok: true, overlay: {} });
    expect(parseOverlayText('{ "Port": "1" }')).toEqual({
      ok: true,
      overlay: { Port: '1' },
    });
    expect(parseOverlayText('{ "Port": 1 }').ok).toBe(false);
    expect(parseOverlayText('[]').ok).toBe(false);
  });

  it('prepares channels for full replace', () => {
    const rows = normalizeChannels([
      { channel_index: 0, name: 'CH0', enabled: true, overlay: { Port: '1' } },
    ]);
    expect(rows[0].overlayText).toContain('Port');
    expect(prepareChannelsForSave(rows)).toEqual({
      ok: true,
      channels: [
        {
          channel_index: 0,
          name: 'CH0',
          enabled: true,
          overlay: { Port: '1' },
        },
      ],
    });
  });

  it('requires channel name and unique index', () => {
    expect(
      prepareChannelsForSave([
        { _key: '1', channel_index: 0, name: '  ', enabled: true, overlayText: '{}' },
      ]),
    ).toEqual({ ok: false, error: '通道名称不能为空' });

    expect(
      prepareChannelsForSave([
        { _key: '1', channel_index: 0, name: 'A', enabled: true, overlayText: '{}' },
        { _key: '2', channel_index: 0, name: 'B', enabled: true, overlayText: '{}' },
      ]),
    ).toEqual({ ok: false, error: '通道序号重复：0' });
  });
});
