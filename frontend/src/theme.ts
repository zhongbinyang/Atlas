import type { ThemeConfig } from 'antd';

export const ATLAS_COLOR = {
  bench: '#D7E0E8',
  panel: '#F4F7FA',
  ink: '#1A2430',
  mute: '#5B6B7C',
  line: '#C5D0DA',
  probe: '#0B6E99',
  live: '#1A7A72',
  lamp: '#C98812',
  fault: '#C23B2E',
} as const;

export const STATUS_LED = {
  online: ATLAS_COLOR.live,
  busy: ATLAS_COLOR.lamp,
  offline: ATLAS_COLOR.fault,
} as const;

export const atlasTheme: ThemeConfig = {
  token: {
    colorPrimary: ATLAS_COLOR.probe,
    colorInfo: ATLAS_COLOR.probe,
    colorSuccess: ATLAS_COLOR.live,
    colorWarning: ATLAS_COLOR.lamp,
    colorError: ATLAS_COLOR.fault,
    colorText: ATLAS_COLOR.ink,
    colorTextSecondary: ATLAS_COLOR.mute,
    colorBgLayout: ATLAS_COLOR.bench,
    colorBgContainer: ATLAS_COLOR.panel,
    colorBorder: ATLAS_COLOR.line,
    colorBorderSecondary: ATLAS_COLOR.line,
    borderRadius: 2,
    fontFamily:
      '"Source Sans 3", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    fontFamilyCode: '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace',
    fontSize: 14,
    controlHeight: 32,
  },
  components: {
    Layout: {
      headerBg: ATLAS_COLOR.ink,
      headerHeight: 56,
      headerPadding: '0 20px',
      bodyBg: ATLAS_COLOR.bench,
    },
    Menu: {
      darkItemBg: 'transparent',
      darkItemSelectedBg: 'transparent',
      darkItemSelectedColor: ATLAS_COLOR.lamp,
      darkItemColor: 'rgba(244, 247, 250, 0.72)',
      darkItemHoverColor: ATLAS_COLOR.panel,
      darkItemHoverBg: 'transparent',
      horizontalItemSelectedColor: ATLAS_COLOR.lamp,
      activeBarHeight: 2,
      activeBarBorderWidth: 0,
    },
    Table: {
      headerBg: '#E4EBF1',
      headerColor: ATLAS_COLOR.ink,
      rowHoverBg: '#EAF1F6',
      borderColor: ATLAS_COLOR.line,
    },
    Card: {
      borderRadiusLG: 2,
    },
    Button: {
      borderRadius: 2,
      primaryShadow: 'none',
    },
    Tag: {
      borderRadiusSM: 2,
    },
    Tabs: {
      itemSelectedColor: ATLAS_COLOR.ink,
      inkBarColor: ATLAS_COLOR.lamp,
    },
  },
};
