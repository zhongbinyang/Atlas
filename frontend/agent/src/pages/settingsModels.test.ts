import { describe, expect, it } from 'vitest';
import {
  flatRowsToSetting,
  isSystemVarName,
  normalizeArrayExpandMode,
  overlayObjectFromUnknown,
  textToSettingJson,
} from './settingsModels';

describe('settingsModels', () => {
  it('normalizes array expand mode and system vars', () => {
    expect(normalizeArrayExpandMode('json')).toBe('json');
    expect(normalizeArrayExpandMode('semicolon')).toBe('semicolon');
    expect(normalizeArrayExpandMode('zip')).toBe('semicolon');
    expect(isSystemVarName('Hostname')).toBe(true);
    expect(isSystemVarName('SN')).toBe(false);
  });

  it('parses INI into nested setting and flat preview rows', () => {
    const { setting, rows } = textToSettingJson(
      '[DCA_Setting]\nIntru_Com_Add=TCPIP0::10.0.0.1\nPort=1;2\n',
      'Device_CFG.ini',
    );
    expect(setting.DCA_Setting).toMatchObject({
      Intru_Com_Add: 'TCPIP0::10.0.0.1',
      Port: [1, 2],
    });
    expect(rows.some((r) => r.flatName === 'DCA_Setting_Intru_Com_Add')).toBe(true);
    expect(rows.find((r) => r.flatName === 'DCA_Setting_Port')?.value).toBe('1;2');
  });

  it('rebuilds setting from flat rows and normalizes overlays', () => {
    const setting = flatRowsToSetting([
      {
        section: 'A',
        key: 'B',
        value: '1;2',
        flatName: 'A_B',
        description: '[A] B',
      },
    ]);
    expect(setting.A).toEqual({ B: [1, 2] });
    expect(overlayObjectFromUnknown({ Port: 7, skip: null })).toEqual({
      Port: '7',
      skip: '',
    });
  });
});
