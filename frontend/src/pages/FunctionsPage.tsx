import { App as AntApp, Button, Card, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { schedulerApi } from '../api/schedulerApi';
import type { Agent, GeneralTemplate, ViTemplate } from '../api/types';
import { PageHeader } from '../components/PageHeader';
import { DEFAULT_TABLE_PAGINATION } from '../utils/tableHelpers';

type FunctionTemplate =
  | (ViTemplate & { _source: 'labview' })
  | (GeneralTemplate & { _source: 'general' | 'rest' | 'cmd' });

function sourceLabel(source: FunctionTemplate['_source']): string {
  if (source === 'general') return '通用';
  if (source === 'rest') return 'REST';
  if (source === 'cmd') return '命令行';
  return 'VI';
}

function sourceColor(source: FunctionTemplate['_source']): string {
  if (source === 'general') return 'blue';
  if (source === 'rest') return 'purple';
  if (source === 'cmd') return 'orange';
  return 'green';
}

function kindLabel(kind: unknown): string {
  if (kind === 'delay') return '延迟';
  if (kind === 'labview') return 'VI';
  if (kind === 'rest') return 'REST';
  if (kind === 'cmd') return '命令行';
  if (kind === 'version') return '版本';
  return typeof kind === 'string' && kind ? kind : '—';
}

function configSummary(template: FunctionTemplate): string {
  if (template._source !== 'labview') {
    if (template.kind === 'delay' && Array.isArray(template.inputs)) {
      const delayInput = template.inputs.find(
        (item): item is { name?: unknown; value?: unknown } =>
          typeof item === 'object' &&
          item !== null &&
          'name' in item &&
          (item as { name?: unknown }).name === 'delay_ms',
      );
      if (delayInput?.value != null) {
        return 'delay_ms=' + String(delayInput.value);
      }
    }
    return '—';
  }
  const timeout = template.timeout_secs != null ? ' | 超时 ' + template.timeout_secs + 's' : '';
  return (template.vi_path || '—') + timeout;
}

function inputsPreview(inputs: unknown): string {
  if (!Array.isArray(inputs) || inputs.length === 0) return '—';
  const preview = inputs
    .slice(0, 3)
    .map((item) => {
      if (typeof item === 'object' && item !== null && 'name' in item) {
        const name = String((item as { name?: unknown }).name ?? '');
        return name || JSON.stringify(item);
      }
      return String(item);
    })
    .join(', ');
  return inputs.length > 3 ? preview + '…' : preview;
}

export function FunctionsPage() {
  const { message, modal } = AntApp.useApp();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [templates, setTemplates] = useState<FunctionTemplate[]>([]);
  const [agentId, setAgentId] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    schedulerApi
      .listAgents()
      .then((nextAgents) => setAgents(Array.isArray(nextAgents) ? nextAgents : []))
      .catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        message.error('加载机台失败：' + detail);
      });
  }, [message]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [viItems, generalItems, restItems, cmdItems] = await Promise.all([
        schedulerApi
          .listViTemplates(agentId || undefined)
          .then((items) => items.map((item) => ({ ...item, _source: 'labview' as const }))),
        schedulerApi
          .listGeneralTemplates(agentId || undefined)
          .then((items) => items.map((item) => ({ ...item, _source: 'general' as const }))),
        schedulerApi
          .listRestTemplates(agentId || undefined)
          .then((items) => items.map((item) => ({ ...item, _source: 'rest' as const }))),
        schedulerApi
          .listCmdTemplates(agentId || undefined)
          .then((items) => items.map((item) => ({ ...item, _source: 'cmd' as const }))),
      ]);
      setTemplates([...viItems, ...generalItems, ...restItems, ...cmdItems]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      message.error('加载功能模板失败：' + detail);
    } finally {
      setLoading(false);
    }
  }, [agentId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const deleteTemplate = useCallback(
    (template: FunctionTemplate) => {
      const label = template.name || String(template.id || '此模板');
      modal.confirm({
        title: '确认删除',
        content: '确定删除「' + label + '」？相关序列队列中的引用也会清除。',
        okText: '删除',
        okType: 'danger',
        cancelText: '取消',
        async onOk() {
          try {
            if (template._source === 'general') {
              await schedulerApi.deleteGeneralTemplate(template.id);
            } else if (template._source === 'rest') {
              await schedulerApi.deleteRestTemplate(template.id);
            } else if (template._source === 'cmd') {
              await schedulerApi.deleteCmdTemplate(template.id);
            } else {
              await schedulerApi.deleteViTemplate(template.id);
            }
            message.success('功能模板已删除');
            await load();
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            message.error('删除失败：' + detail);
            throw error;
          }
        },
      });
    },
    [load, message, modal],
  );

  const columns = useMemo<ColumnsType<FunctionTemplate>>(
    () => [
      { title: 'ID', dataIndex: 'id', render: (value) => <Typography.Text code>{String(value)}</Typography.Text> },
      {
        title: '来源',
        dataIndex: '_source',
        render: (value: FunctionTemplate['_source']) => (
          <Tag color={sourceColor(value)}>{sourceLabel(value)}</Tag>
        ),
      },
      { title: '名称', dataIndex: 'name', sorter: (a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'), render: (value) => value || '—' },
      { title: '类型', dataIndex: 'kind', render: kindLabel },
      { title: '来源机台', dataIndex: 'origin_agent_name', render: (value) => value || '—' },
      {
        title: '路径/配置',
        render: (_, record) => <Typography.Text code>{configSummary(record)}</Typography.Text>,
      },
      { title: '入参', dataIndex: 'inputs', render: inputsPreview },
      {
        title: '操作',
        width: 80,
        fixed: 'right',
        render: (_, record) => (
          <Button danger size="small" onClick={() => deleteTemplate(record)}>
            删除
          </Button>
        ),
      },
    ],
    [deleteTemplate],
  );

  const viTemplates = templates.filter((template) => template._source === 'labview');
  const generalTemplates = templates.filter((template) => template._source === 'general');
  const restTemplates = templates.filter((template) => template._source === 'rest');
  const cmdTemplates = templates.filter((template) => template._source === 'cmd');

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <PageHeader
        title="已注册功能"
        description="中心已注册的四类功能：VI、通用、REST 与命令行。"
        extra={
          <Button onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        }
      />

      <Card>
        <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
          <Space wrap>
            <Typography.Text>机台筛选</Typography.Text>
            <Select
              value={agentId}
              onChange={setAgentId}
              options={[
                { label: '全部', value: '' },
                ...agents.map((agent) => ({ label: agent.name || agent.id, value: agent.id })),
              ]}
              style={{ width: 220 }}
            />
          </Space>
          <Tabs
            items={[
              {
                key: 'labview',
                label: '中心VI功能',
                children: (
                  <Table
                    rowKey={(record) => 'vi-' + String(record.id)}
                    columns={columns}
                    dataSource={viTemplates}
                    loading={loading}
                    locale={{ emptyText: '暂无已注册 VI 功能' }}
                    pagination={DEFAULT_TABLE_PAGINATION}
                    scroll={{ x: true }}
                  />
                ),
              },
              {
                key: 'general',
                label: '中心通用功能',
                children: (
                  <Table
                    rowKey={(record) => 'general-' + String(record.id)}
                    columns={columns}
                    dataSource={generalTemplates}
                    loading={loading}
                    locale={{ emptyText: '暂无已注册通用功能' }}
                    pagination={DEFAULT_TABLE_PAGINATION}
                    scroll={{ x: true }}
                  />
                ),
              },
              {
                key: 'rest',
                label: '中心REST功能',
                children: (
                  <Table
                    rowKey={(record) => 'rest-' + String(record.id)}
                    columns={columns}
                    dataSource={restTemplates}
                    loading={loading}
                    locale={{ emptyText: '暂无已注册 REST 功能' }}
                    pagination={DEFAULT_TABLE_PAGINATION}
                    scroll={{ x: true }}
                  />
                ),
              },
              {
                key: 'cmd',
                label: '中心命令行功能',
                children: (
                  <Table
                    rowKey={(record) => 'cmd-' + String(record.id)}
                    columns={columns}
                    dataSource={cmdTemplates}
                    loading={loading}
                    locale={{ emptyText: '暂无已注册命令行功能' }}
                    pagination={DEFAULT_TABLE_PAGINATION}
                    scroll={{ x: true }}
                  />
                ),
              },
            ]}
          />
        </Space>
      </Card>
    </Space>
  );
}
