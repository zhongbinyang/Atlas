import { App as AntApp, Button, Card, Input, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { schedulerApi } from '../api/schedulerApi';
import type { UnitRow } from '../api/types';

type EditableUnitRow = UnitRow & { _key: string };

const DEFAULT_CENTER_UNITS: UnitRow[] = [
  { symbol: 'dBm', description: '光功率，相对 1 mW' },
  { symbol: 'dB', description: '相对量（消光比、回损、增益等）' },
  { symbol: 'nm', description: '波长' },
  { symbol: '°C', description: '温度（壳体/环境）' },
  { symbol: 'V', description: '电压（供电/监测）' },
  { symbol: 'mA', description: '电流（偏置、功耗）' },
  { symbol: 'mW', description: '光功率（毫瓦）' },
  { symbol: 'µW', description: '光功率（微瓦）' },
  { symbol: 'Gbps', description: '线速率 / 比特率' },
  { symbol: 'ps', description: '时间或抖动（皮秒）' },
  { symbol: 'UI', description: 'Unit Interval（归一化抖动）' },
  { symbol: '%', description: '百分比' },
];

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
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const nextUnits = await schedulerApi.listUnits();
      setUnits(normalizeUnits(Array.isArray(nextUnits) ? nextUnits : []));
      message.success('已加载 ' + nextUnits.length + ' 个单位');
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

  const updateUnit = useCallback((index: number, patch: Partial<UnitRow>) => {
    setUnits((current) =>
      current.map((unit, unitIndex) => (unitIndex === index ? { ...unit, ...patch } : unit)),
    );
  }, []);

  const removeUnit = useCallback((index: number) => {
    setUnits((current) => current.filter((_, unitIndex) => unitIndex !== index));
  }, []);

  const addUnit = useCallback(() => {
    setUnits((current) => [...current, { _key: unitKey(), symbol: '', description: '' }]);
  }, []);

  const restoreDefaults = useCallback(() => {
    setUnits(normalizeUnits(DEFAULT_CENTER_UNITS));
    message.success('已恢复默认单位（未保存）');
  }, [message]);

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
        render: (value, _record, index) => (
          <Input
            maxLength={32}
            value={String(value || '')}
            onChange={(event) => updateUnit(index, { symbol: event.target.value })}
          />
        ),
      },
      {
        title: '说明',
        dataIndex: 'description',
        render: (value, _record, index) => (
          <Input
            maxLength={200}
            value={String(value || '')}
            onChange={(event) => updateUnit(index, { description: event.target.value })}
          />
        ),
      },
      {
        title: '',
        render: (_, _record, index) => (
          <Button danger size="small" onClick={() => removeUnit(index)}>
            删除
          </Button>
        ),
      },
    ],
    [removeUnit, updateUnit],
  );

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          单位
        </Typography.Title>
        <Space>
          <Button onClick={restoreDefaults}>恢复默认</Button>
          <Button onClick={addUnit}>+ 添加</Button>
          <Button type="primary" onClick={() => void save()} loading={saving}>
            保存
          </Button>
        </Space>
      </Space>

      <Typography.Text type="secondary">全局共享；所有机台 Spec 单位下拉共用此表。</Typography.Text>

      <Card>
        <Table
          rowKey={(record) => record._key}
          columns={columns}
          dataSource={units}
          loading={loading}
          locale={{ emptyText: '暂无单位，可添加或恢复默认' }}
          pagination={false}
        />
      </Card>
    </Space>
  );
}
