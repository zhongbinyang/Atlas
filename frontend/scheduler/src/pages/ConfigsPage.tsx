import {
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Modal,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { schedulerApi } from '../api/schedulerApi';
import type { AgentConfigSummary, AgentConfigTemplate } from '../api/types';

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function ConfigsPage() {
  const { message } = AntApp.useApp();
  const [summaries, setSummaries] = useState<AgentConfigSummary[]>([]);
  const [templates, setTemplates] = useState<AgentConfigTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<AgentConfigSummary | null>(null);
  const [templateDetail, setTemplateDetail] = useState<Record<string, unknown> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [summaryItems, templateItems] = await Promise.all([
        schedulerApi.listAgentConfigSummaries(),
        schedulerApi.listAgentConfigTemplates(),
      ]);
      setSummaries(summaryItems);
      setTemplates(templateItems);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      message.error('加载机台配置失败：' + detail);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const openAgentDetail = async (row: AgentConfigSummary) => {
    setDetail(row);
    try {
      const settings = await schedulerApi.getAgentSettings(row.agent_id);
      const channels = await schedulerApi.getAgentChannels(row.agent_id);
      setDetail({ ...row, _settings: settings, _channels: channels } as AgentConfigSummary);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      message.error('加载详情失败：' + text);
    }
  };

  const openTemplateDetail = async (row: AgentConfigTemplate) => {
    try {
      const data = await schedulerApi.getAgentConfigTemplate(row.id);
      setTemplateDetail(data);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      message.error('加载模板详情失败：' + text);
    }
  };

  const deleteTemplate = (template: AgentConfigTemplate) => {
    const label = template.name || String(template.id || '此模板');
    Modal.confirm({
      title: '确认删除',
      content: `确定删除配置模板「${label}」？`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      async onOk() {
        await schedulerApi.deleteAgentConfigTemplate(template.id);
        message.success('配置模板已删除');
        await load();
      },
    });
  };

  const summaryColumns = useMemo<ColumnsType<AgentConfigSummary>>(
    () => [
      { title: '机台', dataIndex: 'agent_name', render: (value) => value || '—' },
      { title: 'IP', dataIndex: 'agent_ip', width: 140 },
      {
        title: '状态',
        dataIndex: 'agent_status',
        width: 90,
        render: (value) => (
          <Tag color={value === 'online' ? 'success' : 'default'}>{value || '—'}</Tag>
        ),
      },
      { title: '变量', dataIndex: 'variable_count', width: 72 },
      { title: '设备档', dataIndex: 'device_profile_count', width: 80 },
      { title: '校准档', dataIndex: 'calibration_profile_count', width: 80 },
      {
        title: '当前设备档',
        dataIndex: 'active_device_name',
        render: (value) => value || '—',
      },
      {
        title: '当前校准档',
        dataIndex: 'active_calibration_name',
        render: (value) => value || '—',
      },
      { title: '通道', dataIndex: 'channel_count', width: 72 },
      {
        title: '数组展开',
        dataIndex: 'array_expand_mode',
        width: 100,
        render: (value) => String(value || 'semicolon'),
      },
      {
        title: '操作',
        width: 80,
        render: (_, row) => (
          <Button size="small" type="link" onClick={() => void openAgentDetail(row)}>
            查看
          </Button>
        ),
      },
    ],
    [],
  );

  const templateColumns = useMemo<ColumnsType<AgentConfigTemplate>>(
    () => [
      { title: 'ID', dataIndex: 'id', width: 72 },
      { title: '名称', dataIndex: 'name' },
      { title: '来源机台', dataIndex: 'source_agent_name', render: (value) => value || '—' },
      { title: '创建机台', dataIndex: 'created_by_agent_name', render: (value) => value || '—' },
      {
        title: '操作',
        width: 160,
        render: (_, row) => (
          <Space>
            <Button size="small" type="link" onClick={() => void openTemplateDetail(row)}>
              查看
            </Button>
            <Button size="small" danger onClick={() => deleteTemplate(row)}>
              删除
            </Button>
          </Space>
        ),
      },
    ],
    [],
  );

  const detailSettings = asRecord((detail as { _settings?: unknown } | null)?._settings);
  const detailChannels = Array.isArray((detail as { _channels?: unknown } | null)?._channels)
    ? ((detail as { _channels?: unknown[] })._channels as unknown[])
    : [];

  const templateConfig = asRecord(templateDetail?.config);

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          机台配置
        </Typography.Title>
        <Button onClick={() => void load()} loading={loading}>
          刷新
        </Button>
      </Space>

      <Card>
        <Tabs
          items={[
            {
              key: 'agents',
              label: '各机台当前配置',
              children: (
                <Table
                  rowKey={(row) => row.agent_id}
                  columns={summaryColumns}
                  dataSource={summaries}
                  loading={loading}
                  locale={{ emptyText: '暂无机台配置' }}
                  pagination={false}
                  scroll={{ x: true }}
                />
              ),
            },
            {
              key: 'templates',
              label: '中心配置模板',
              children: (
                <Table
                  rowKey={(row) => String(row.id)}
                  columns={templateColumns}
                  dataSource={templates}
                  loading={loading}
                  locale={{ emptyText: '暂无配置模板（可在 Agent 配置页保存）' }}
                  pagination={false}
                  scroll={{ x: true }}
                />
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title={detail ? `配置详情 · ${detail.agent_name}` : '配置详情'}
        open={!!detail}
        onCancel={() => setDetail(null)}
        footer={null}
        width={900}
        destroyOnClose
      >
        {detail ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="机台 ID">{detail.agent_id}</Descriptions.Item>
              <Descriptions.Item label="IP">{detail.agent_ip}</Descriptions.Item>
              <Descriptions.Item label="变量数">{detail.variable_count}</Descriptions.Item>
              <Descriptions.Item label="通道数">{detail.channel_count}</Descriptions.Item>
              <Descriptions.Item label="当前设备档">
                {detail.active_device_name || '—'}
              </Descriptions.Item>
              <Descriptions.Item label="当前校准档">
                {detail.active_calibration_name || '—'}
              </Descriptions.Item>
            </Descriptions>
            <Typography.Title level={5}>变量</Typography.Title>
            <Table
              size="small"
              pagination={false}
              rowKey={(_, index) => String(index)}
              dataSource={Array.isArray(detailSettings.variables) ? detailSettings.variables : []}
              columns={[
                { title: '名称', dataIndex: 'name' },
                { title: '值', dataIndex: 'value' },
                { title: '说明', dataIndex: 'description' },
              ]}
            />
            <Typography.Title level={5}>通道</Typography.Title>
            <Table
              size="small"
              pagination={false}
              rowKey={(_, index) => String(index)}
              dataSource={detailChannels}
              columns={[
                { title: '#', dataIndex: 'channel_index', width: 64 },
                { title: '名称', dataIndex: 'name' },
                {
                  title: '启用',
                  dataIndex: 'enabled',
                  width: 72,
                  render: (value) => (value === false ? '否' : '是'),
                },
                {
                  title: 'Overlay 键数',
                  render: (_, row) => {
                    const overlay = asRecord(asRecord(row).overlay);
                    return Object.keys(overlay).length;
                  },
                },
              ]}
            />
          </Space>
        ) : null}
      </Modal>

      <Modal
        title={templateDetail ? `模板详情 · ${String(templateDetail.name || '')}` : '模板详情'}
        open={!!templateDetail}
        onCancel={() => setTemplateDetail(null)}
        footer={null}
        width={720}
        destroyOnClose
      >
        {templateDetail ? (
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="来源机台">
              {String(templateDetail.source_agent_name || '—')}
            </Descriptions.Item>
            <Descriptions.Item label="创建机台">
              {String(templateDetail.created_by_agent_name || '—')}
            </Descriptions.Item>
            <Descriptions.Item label="变量数">
              {Array.isArray(templateConfig.variables) ? templateConfig.variables.length : 0}
            </Descriptions.Item>
            <Descriptions.Item label="设备档数">
              {Array.isArray(templateConfig.device_profiles)
                ? templateConfig.device_profiles.length
                : 0}
            </Descriptions.Item>
            <Descriptions.Item label="校准档数">
              {Array.isArray(templateConfig.calibration_profiles)
                ? templateConfig.calibration_profiles.length
                : 0}
            </Descriptions.Item>
            <Descriptions.Item label="通道数">
              {Array.isArray(templateConfig.channels) ? templateConfig.channels.length : 0}
            </Descriptions.Item>
          </Descriptions>
        ) : null}
      </Modal>
    </Space>
  );
}
