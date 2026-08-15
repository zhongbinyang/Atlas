import { describe, expect, it } from 'vitest';
import { DEFAULT_TABLE_PAGINATION, EDITOR_TABLE_PAGINATION } from './tableHelpers';

describe('table pagination', () => {
  it('uses 20 rows on list tables and 10 on editor tables', () => {
    expect(DEFAULT_TABLE_PAGINATION.pageSize).toBe(20);
    expect(DEFAULT_TABLE_PAGINATION.showSizeChanger).toBe(true);
    expect(EDITOR_TABLE_PAGINATION.pageSize).toBe(10);
    expect(EDITOR_TABLE_PAGINATION.showSizeChanger).toBe(true);
  });
});
