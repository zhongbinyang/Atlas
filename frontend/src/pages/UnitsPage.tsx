import { App as AntApp, Button, Card, Input, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { schedulerApi } from '../api/schedulerApi';
import type { UnitRow } from '../api/types';
import { PageHeader } from '../components/PageHeader';
import { insertAtPageStart, matchesTableQuery } from '../utils/tableHelpers';
import { useTablePagination } from '../utils/useTablePagination';

type EditableUnitRow = UnitRow & { _key: string };

let nextUnitKey = 0;

function unitKey(): string {
  nextUnitKey += 1;
  return 'unit-' + nextUnitKey;
}

function normalizeUnits(units: UnitRow[]): EditableUnitRow[] {
  return units.map((unit) => ({
    _key: unitKey(),
    symbol: unit.symbol || '',
    description: unit.description || '',
  }));
}

export function UnitsPage() {
  const { message } = AntApp.useApp();
  const [units, setUnits] = useState<EditableUnitRow[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const { current, pageSize, pagination, showFirstPage } = useTablePagination();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const nextUnits = await schedulerApi.listUnits();
      setUnits(normalizeUnits(Array.isArray(nextUnits) ? nextUnits : []));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setUnits([]);
      message.error('加载单位失败：' + detail);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateUnit = useCallback((key: string, patch: Partial<UnitRow>) => {
    setUnits((current) =>
      current.map((unit) => (unit._key === key ? { ...unit, ...patch } : unit)),
    );
  }, []);

  const removeUnit = useCallback((key: string) => {
    setUnits((current) => current.filter((unit) => unit._key !== key));
  }, []);

  const addUnit = useCallback(() => {
    setQuery('');
    setUnits((currentUnits) =>
      insertAtPageStart(
        currentUnits,
        { _key: unitKey(), symbol: '', description: '' },
        current,
        pageSize,
      ),
    );
  }, [current, pageSize]);

  const visibleUnits = useMemo(
    () => units.filter((unit) => matchesTableQuery(query, [unit.symbol, unit.description])),
    [query, units],
  );

  const save = useCallback(async () => {
    const unitsToSave = units
      .map((unit) => ({
        symbol: String(unit.symbol || '').trim(),
        description: String(unit.description || '').trim(),
      }))
      .filter((unit) => unit.symbol);
    const seen = new Set<string>();

    for (const unit of unitsToSave) {
      if (unit.symbol.length > 32) {
        message.error('单位过长：' + unit.symbol);
        return;
      }
      if (unit.description.length > 200) {
        message.error('说明过长：' + unit.symbol);
        return;
      }
      if (seen.has(unit.symbol)) {
        message.error('重复单位：' + unit.symbol);
        return;
      }
      seen.add(unit.symbol);
    }

    setSaving(true);
    try {
      const result = await schedulerApi.saveUnits(unitsToSave);
      const savedUnits = Array.isArray(result.units) ? result.units : unitsToSave;
      setUnits(normalizeUnits(savedUnits));
      message.success('已保存 ' + savedUnits.length + ' 个单位');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      message.error('保存单位失败：' + detail);
    } finally {
      setSaving(false);
    }
  }, [message, units]);

  const columns = useMemo<ColumnsType<EditableUnitRow>>(
    () => [
      {
        title: '单位',
        dataIndex: 'symbol',
        render: (value, record) => (
          <Input
            variant="borderless"
            size="small"
            maxLength={32}
            value={String(value || '')}
            onChange={(event) => updateUnit(record._key, { symbol: event.target.value })}
          />
        ),
      },
      {
        title: '说明',
        dataIndex: 'description',
        render: (value, record) => (
          <Input
            variant="borderless"
            size="small"
            maxLength={200}
            value={String(value || '')}
            onChange={(event) => updateUnit(record._key, { description: event.target.value })}
          />
        ),
      },
      {
        title: '操作',
        width: 80,
        fixed: 'right',
        render: (_, record) => (
          <Button danger size="small" onClick={() => removeUnit(record._key)}>
            删除
          </Button>
        ),
      },
    ],
    [removeUnit, updateUnit],
  );

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <PageHeader
        title="单位"
        description="全局共享；所有机台 Spec 单位下拉共用此表。"
        extra={
          <Space>
            <Button onClick={addUnit}>新建</Button>
            <Button type="primary" onClick={() => void save()} loading={saving}>
              保存
            </Button>
            <Button onClick={() => void load()} loading={loading}>
              刷新
            </Button>
          </Space>
        }
      />

      <Card>
        <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
          <Space wrap align="center">
            <Typography.Text>筛选</Typography.Text>
            <Input
              allowClear
              placeholder="单位或说明"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                showFirstPage();
              }}
              style={{ width: 240 }}
            />
          </Space>
          <Table
            rowKey={(record) => record._key}
            columns={columns}
            dataSource={visibleUnits}
            loading={loading}
            locale={{ emptyText: query.trim() ? '无匹配单位' : '暂无单位，可新建' }}
            pagination={pagination}
            scroll={{ x: true }}
          />
        </Space>
      </Card>
    </Space>
  );
}
