import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TABLE_PAGINATION,
  EDITOR_TABLE_PAGINATION,
  insertAtPageStart,
  matchesTableQuery,
} from './tableHelpers';

describe('table pagination', () => {
  it('defaults to 10 rows and leaves pageSize uncontrolled so the size changer works', () => {
    expect(DEFAULT_TABLE_PAGINATION.defaultPageSize).toBe(10);
    expect(DEFAULT_TABLE_PAGINATION.pageSize).toBeUndefined();
    expect(DEFAULT_TABLE_PAGINATION.hideOnSinglePage).toBeFalsy();
    expect(DEFAULT_TABLE_PAGINATION.showSizeChanger).toBe(true);
    expect(EDITOR_TABLE_PAGINATION.defaultPageSize).toBe(10);
    expect(EDITOR_TABLE_PAGINATION.pageSize).toBeUndefined();
    expect(EDITOR_TABLE_PAGINATION.hideOnSinglePage).toBeFalsy();
  });
});

describe('insertAtPageStart', () => {
  it('inserts the new row at the start of the current page', () => {
    expect(insertAtPageStart(['a', 'b', 'c'], 'new', 1, 10)).toEqual(['new', 'a', 'b', 'c']);
    expect(insertAtPageStart(['a', 'b', 'c', 'd'], 'new', 2, 2)).toEqual(['a', 'b', 'new', 'c', 'd']);
    expect(insertAtPageStart(['a'], 'new', 3, 10)).toEqual(['a', 'new']);
  });
});

describe('matchesTableQuery', () => {
  it('matches any field case-insensitively and treats blank query as all rows', () => {
    expect(matchesTableQuery('  ', ['dBm', '功率'])).toBe(true);
    expect(matchesTableQuery('dbm', ['TX_AP', 'dBm'])).toBe(true);
    expect(matchesTableQuery('功率', ['dBm', '发射功率'])).toBe(true);
    expect(matchesTableQuery('ul', ['TX_AP', '1.0'])).toBe(false);
  });
});
