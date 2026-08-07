import { App, Button, Card, Col, Input, Row, Space, Table, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { agentApi } from '../../api/agentApi';
import { ApiError } from '../../api/client';

type CatalogItem = {
  id?: string | number;
  name?: string;
  kind?: string;
  origin_agent_name?: string;
  inputs?: unknown;
  source: 'labview' | 'general';
};

type QueueItem = {
  template_id?: string | number;
  template_kind?: string;
  name?: string;
  inputs?: unknown;
  enabled?: boolean;
  fail_policy?: string;
  limits?: unknown[];
  note?: string;
  resources?: unknown[];
  [key: string]: unknown;
};

type SequenceTemplate = {
  id?: string | number;
  name?: string;
  step_count?: number;
  created_by_agent_name?: string;
};

const getErrorMessage = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : String(error);

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function SequenceEditTab() {
  const { message } = App.useApp();
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [templates, setTemplates] = useState<SequenceTemplate[]>([]);
  const [activeTemplateId, setActiveTemplateId] = useState<string | number | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const loadAll = useCallback(async () => {
    setBusy(true);
    try {
      const [vi, general, queueResp, tpl] = await Promise.all([
        agentApi.labviewAllTemplates(),
        agentApi.generalAllTemplates(),
        agentApi.getRunQueue(),
        agentApi.listSequenceTemplates(),
      ]);
      const viItems = (Array.isArray(vi) ? vi : []).map((item) => ({
        ...(asRecord(item) as CatalogItem),
        source: 'labview' as const,
      }));
      const generalItems = (Array.isArray(general) ? general : []).map((item) => ({
        ...(asRecord(item) as CatalogItem),
        source: 'general' as const,
      }));
      setCatalog([...viItems, ...generalItems]);
      const queueData = asRecord(queueResp);
      setQueue(Array.isArray(queueData.items) ? (queueData.items as QueueItem[]) : []);
      setTemplates(Array.isArray(tpl) ? (tpl as SequenceTemplate[]) : []);
    } catch (error) {
      message.error(`加载序列编排数据失败: ${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }, [message]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const filteredCatalog = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((item) =>
      [item.name, item.id, item.origin_agent_name, item.kind, item.source]
        .map((v) => String(v ?? '').toLowerCase())
        .some((v) => v.includes(q)),
    );
  }, [catalog, query]);

  const persistQueue = async (next: QueueItem[]) => {
    setBusy(true);
    try {
      const body = {
        items: next.map((item) => ({
          template_id: item.template_id,
          template_kind: item.template_kind,
          name: item.name,
          inputs: item.inputs != null && typeof item.inputs === 'object' ? item.inputs : [],
          enabled: item.enabled !== false,
          breakpoint: false,
          fail_policy: item.fail_policy === 'continue' ? 'continue' : 'stop',
          limits: Array.isArray(item.limits) ? item.limits : [],
          note: item.note || '',
          resources: Array.isArray(item.resources) ? item.resources : [],
        })),
      };
      const data = asRecord(await agentApi.putRunQueue(body));
      setQueue(Array.isArray(data.items) ? (data.items as QueueItem[]) : next);
      message.success('队列已保存');
    } catch (error) {
      message.error(`保存队列失败: ${getErrorMessage(error)}`);
      await loadAll();
    } finally {
      setBusy(false);
    }
  };

  const addToQueue = async (item: CatalogItem) => {
    const next = [
      ...queue,
      {
        template_id: item.id,
        template_kind: item.source === 'labview' ? 'labview' : item.kind || 'general',
        name: item.name,
        inputs: item.inputs ?? [],
        enabled: true,
        fail_policy: 'stop',
        limits: [],
        note: '',
        resources: [],
      },
    ];
    setQueue(next);
    await persistQueue(next);
  };

  const move = async (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= queue.length) return;
    const next = queue.slice();
    const [row] = next.splice(index, 1);
    next.splice(target, 0, row);
    setQueue(next);
    await persistQueue(next);
  };

  const removeAt = async (index: number) => {
    const next = queue.filter((_, i) => i !== index);
    setQueue(next);
    await persistQueue(next);
  };

  const saveTemplate = async () => {
    if (!queue.length) {
      message.error('当前队列为空，无法保存模板');
      return;
    }
    const name = window.prompt('请输入序列模板名称')?.trim() || '';
    if (!name) return;
    const note = window.prompt('备注（可选）')?.trim() || '';
    setBusy(true);
    try {
      const data = asRecord(await agentApi.saveSequenceTemplate({ name, note }));
      setActiveTemplateId((data.id as string | number) ?? null);
      message.success(`已保存序列模板: ${String(data.name ?? name)}`);
      await loadAll();
    } catch (error) {
      message.error(`保存模板失败: ${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const loadTemplate = async (id: string | number) => {
    setBusy(true);
    try {
      await agentApi.loadSequenceTemplate(id);
      setActiveTemplateId(id);
      message.success('已加载模板到本机队列');
      await loadAll();
    } catch (error) {
      message.error(`加载模板失败: ${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Typography.Text type="secondary">
        {activeTemplateId != null ? `当前模板 ID: ${String(activeTemplateId)}` : '当前未绑定序列模板'}
      </Typography.Text>
      <Row gutter={16}>
        <Col span={12}>
          <Card title="中心全部功能" extra={<Input.Search allowClear placeholder="搜索" onSearch={setQuery} onChange={(e) => setQuery(e.target.value)} style={{ width: 200 }} />}>
            <Table
              size="small"
              loading={busy}
              rowKey={(row) => `${row.source}-${String(row.id)}`}
              dataSource={filteredCatalog}
              pagination={{ pageSize: 8 }}
              columns={[
                { title: '名称', dataIndex: 'name' },
                { title: '来源', dataIndex: 'source', width: 80 },
                {
                  title: '操作',
                  width: 90,
                  render: (_, row) => (
                    <Button size="small" onClick={() => void addToQueue(row)}>
                      加入
                    </Button>
                  ),
                },
              ]}
            />
          </Card>
        </Col>
        <Col span={12}>
          <Card
            title="执行顺序"
            extra={
              <Space>
                <Button onClick={() => void loadAll()} loading={busy}>
                  刷新
                </Button>
                <Button type="primary" onClick={saveTemplate} loading={busy}>
                  保存为模板
                </Button>
              </Space>
            }
          >
            <Table
              size="small"
              loading={busy}
              rowKey={(_, index) => String(index)}
              dataSource={queue}
              pagination={false}
              columns={[
                { title: '#', width: 50, render: (_, __, index) => index + 1 },
                { title: '名称', dataIndex: 'name' },
                {
                  title: '操作',
                  width: 200,
                  render: (_, __, index) => (
                    <Space>
                      <Button size="small" onClick={() => void move(index, -1)}>
                        上移
                      </Button>
                      <Button size="small" onClick={() => void move(index, 1)}>
                        下移
                      </Button>
                      <Button size="small" danger onClick={() => void removeAt(index)}>
                        删除
                      </Button>
                    </Space>
                  ),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>

      <Card title="中心序列模板">
        <Table
          size="small"
          loading={busy}
          rowKey={(row) => String(row.id)}
          dataSource={templates}
          pagination={false}
          columns={[
            { title: 'ID', dataIndex: 'id', width: 80 },
            { title: '名称', dataIndex: 'name' },
            { title: '步骤', dataIndex: 'step_count', width: 80 },
            { title: '创建者', dataIndex: 'created_by_agent_name' },
            {
              title: '操作',
              width: 100,
              render: (_, row) =>
                row.id != null ? (
                  <Button size="small" onClick={() => void loadTemplate(row.id!)}>
                    加载
                  </Button>
                ) : null,
            },
          ]}
        />
      </Card>
    </Space>
  );
}
