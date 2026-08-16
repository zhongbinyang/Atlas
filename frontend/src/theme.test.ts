import { describe, expect, it } from 'vitest';
import { ATLAS_COLOR, STATUS_LED, atlasTheme } from './theme';

describe('atlasTheme', () => {
  it('uses the metrology bench palette instead of default Ant blue', () => {
    expect(atlasTheme.token?.colorPrimary).toBe(ATLAS_COLOR.probe);
    expect(atlasTheme.token?.colorBgLayout).toBe(ATLAS_COLOR.bench);
    expect(atlasTheme.token?.borderRadius).toBe(2);
    expect(STATUS_LED.busy).toBe(ATLAS_COLOR.lamp);
  });
});
