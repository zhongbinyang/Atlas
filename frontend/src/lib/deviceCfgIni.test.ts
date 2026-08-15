import { describe, expect, it } from 'vitest';
import { prepareSettingFromRows, settingToEditableRows, textToSettingJson } from './deviceCfgIni';

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

  it('roundtrips nested setting through editable rows', () => {
    const { setting } = textToSettingJson(
      '[DCA_Setting]\nIntru_Com_Add=TCPIP0::10.0.0.1\nPort=1;2\n',
      'Device_CFG.ini',
    );
    const rows = settingToEditableRows(setting);
    expect(rows.find((row) => row.section === 'DCA_Setting' && row.key === 'Port')?.value).toBe(
      '1;2',
    );
    const prepared = prepareSettingFromRows(rows);
    expect(prepared).toEqual({
      ok: true,
      setting: {
        DCA_Setting: {
          Intru_Com_Add: 'TCPIP0::10.0.0.1',
          Port: [1, 2],
        },
      },
    });
  });

  it('rejects duplicate section+key and incomplete rows', () => {
    expect(
      prepareSettingFromRows([
        { _key: '1', section: 'A', key: 'K', value: '1' },
        { _key: '2', section: 'A', key: 'K', value: '2' },
      ]),
    ).toEqual({ ok: false, error: '重复项：[A] K' });
    expect(
      prepareSettingFromRows([{ _key: '1', section: 'A', key: '', value: '1' }]),
    ).toEqual({ ok: false, error: '段和键必须同时填写' });
  });

  it('skips fully empty rows when saving', () => {
    expect(
      prepareSettingFromRows([
        { _key: '1', section: '', key: '', value: '' },
        { _key: '2', section: 'A', key: 'K', value: '1' },
      ]),
    ).toEqual({ ok: true, setting: { A: { K: 1 } } });
  });
});
