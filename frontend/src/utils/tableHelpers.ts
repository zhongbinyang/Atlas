import type { TablePaginationConfig } from 'antd';

export const DEFAULT_TABLE_PAGINATION: TablePaginationConfig = {
  defaultPageSize: 10,
  showSizeChanger: true,
  pageSizeOptions: ['10', '20', '50', '100'],
  showTotal: (total) => `共 ${total} 条`,
};

export const EDITOR_TABLE_PAGINATION: TablePaginationConfig = {
  ...DEFAULT_TABLE_PAGINATION,
};

export function insertAtPageStart<T>(items: T[], item: T, page: number, pageSize: number): T[] {
  const start = Math.max(0, (Math.max(1, page) - 1) * Math.max(1, pageSize));
  const index = Math.min(start, items.length);
  return [...items.slice(0, index), item, ...items.slice(index)];
}

export function matchesTableQuery(
  query: string,
  values: Array<string | number | null | undefined>,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return values.some((value) => String(value ?? '').toLowerCase().includes(needle));
}

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
