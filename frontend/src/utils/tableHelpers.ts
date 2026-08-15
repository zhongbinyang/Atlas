import type { TablePaginationConfig } from 'antd';

export const DEFAULT_TABLE_PAGINATION: TablePaginationConfig = {
  pageSize: 20,
  showSizeChanger: true,
  pageSizeOptions: ['10', '20', '50', '100'],
  hideOnSinglePage: true,
  showTotal: (total) => `共 ${total} 条`,
};

export const EDITOR_TABLE_PAGINATION: TablePaginationConfig = {
  pageSize: 10,
  showSizeChanger: true,
  pageSizeOptions: ['10', '20', '50', '100'],
  showTotal: (total) => `共 ${total} 条`,
};

export function formatTimestamp(value: unknown): string {
  if (value == null || value === '') return '—';
  const text = String(value);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function timestampSorter(a: unknown, b: unknown): number {
  const ta = new Date(String(a ?? '')).getTime();
  const tb = new Date(String(b ?? '')).getTime();
  const na = Number.isNaN(ta) ? 0 : ta;
  const nb = Number.isNaN(tb) ? 0 : tb;
  return na - nb;
}

export function textSorter(field: string) {
  return (left: Record<string, unknown>, right: Record<string, unknown>) =>
    String(left[field] ?? '').localeCompare(String(right[field] ?? ''), 'zh-CN');
}
