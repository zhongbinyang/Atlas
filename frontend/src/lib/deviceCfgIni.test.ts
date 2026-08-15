import { describe, expect, it } from 'vitest';
import { textToSettingJson } from './deviceCfgIni';

describe('deviceCfgIni', () => {
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
});
