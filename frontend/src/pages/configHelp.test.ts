import { describe, expect, it } from 'vitest';
import { CONFIG_HELP } from './configHelp';

describe('CONFIG_HELP', () => {
  it('explains overlay as per-channel overrides with merge order', () => {
    expect(CONFIG_HELP.overlay).toContain('通道 Overlay');
    expect(CONFIG_HELP.overlay).toContain('手工变量');
    expect(CONFIG_HELP.overlay).toContain('设备档');
    expect(CONFIG_HELP.overlay).toContain('校验档');
  });

  it('explains INI import as compatibility only', () => {
    expect(CONFIG_HELP.iniImport).toContain('兼容');
    expect(CONFIG_HELP.deviceProfile).toContain('数据库');
  });
});
