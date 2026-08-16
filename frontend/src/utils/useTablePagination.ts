import type { TablePaginationConfig } from 'antd';
import { useCallback, useMemo, useState } from 'react';
import { DEFAULT_TABLE_PAGINATION } from './tableHelpers';

const DEFAULT_PAGE_SIZE = DEFAULT_TABLE_PAGINATION.defaultPageSize ?? 10;

export function useTablePagination() {
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const showFirstPage = useCallback(() => setCurrent(1), []);

  const pagination = useMemo<TablePaginationConfig>(
    () => ({
      ...DEFAULT_TABLE_PAGINATION,
      current,
      pageSize,
      onChange(page, size) {
        setCurrent(page);
        setPageSize(size);
      },
    }),
    [current, pageSize],
  );

  return { current, pageSize, pagination, showFirstPage };
}
