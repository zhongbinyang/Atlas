import type { ThemeConfig } from 'antd';

/** ATLAS Agent — cool industrial blue, Ant Design 5 defaults otherwise. */
export const agentTheme: ThemeConfig = {
  token: {
    colorPrimary: '#1a6fb5',
    colorInfo: '#1a6fb5',
    colorSuccess: '#2f8f5b',
    colorWarning: '#c47f17',
    colorError: '#c53d3d',
    borderRadius: 6,
    fontFamily:
      '"Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif',
    fontFamilyCode: 'ui-monospace, "Cascadia Code", Consolas, "Courier New", monospace',
    colorBgLayout: '#e8edf2',
    colorBgContainer: '#ffffff',
    controlHeight: 32,
  },
  components: {
    Layout: {
      headerBg: '#0f2a3d',
      headerHeight: 56,
      headerPadding: '0 20px',
      bodyBg: '#e8edf2',
    },
    Menu: {
      darkItemBg: 'transparent',
      darkSubMenuItemBg: 'transparent',
      darkItemSelectedBg: 'rgba(255,255,255,0.12)',
      darkItemHoverBg: 'rgba(255,255,255,0.08)',
      itemBorderRadius: 4,
      horizontalItemBorderRadius: 4,
    },
    Card: {
      headerFontSize: 15,
      paddingLG: 20,
    },
    Table: {
      headerBg: '#f4f7fa',
    },
  },
};
