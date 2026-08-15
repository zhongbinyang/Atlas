import {
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Modal,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { schedulerApi } from '../api/schedulerApi';
import type { AgentConfigSummary, AgentConfigTemplate } from '../api/types';
import { HelpLabel } from '../components/HelpTip';
import { PageHeader } from '../components/PageHeader';
import { DEFAULT_TABLE_PAGINATION, formatTimestamp, textSorter, timestampSorter } from '../utils/tableHelpers';
import { CONFIG_HELP } from './configHelp';

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function ConfigsPage() {
  const { message, modal } = AntApp.useApp();
  const navigate = useNavigate();
  const [summaries, setSummaries] = useState<AgentConfigSummary[]>([]);
  const [templates, setTemplates] = useState<AgentConfigTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [templateDetailOpen, setTemplateDetailOpen] = useState(false);
  const [templateDetail, setTemplateDetail] = useState<Record<string, unknown> | null>(null);
  const [templateDetailLoading, setTemplateDetailLoading] = useState(false);

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
      message.error(`加载机台配置失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const closeTemplateDetail = () => {
    setTemplateDetailOpen(false);
    setTemplateDetail(null);
    setTemplateDetailLoading(false);
  };

  const openTemplateDetail = async (row: AgentConfigTemplate) => {
    setTemplateDetailOpen(true);
    setTemplateDetail({ id: row.id, name: row.name });
    setTemplateDetailLoading(true);
    try {
      const data = await schedulerApi.getAgentConfigTemplate(row.id);
      setTemplateDetail(data);
    } catch (error) {
      message.error(`加载模板详情失败：${error instanceof Error ? error.message : String(error)}`);
      closeTemplateDetail();
    } finally {
      setTemplateDetailLoading(false);
    }
  };

  const deleteTemplate = (template: AgentConfigTemplate) => {
    const label = template.name || String(template.id || '此模板');
    modal.confirm({
      title: '确认删除',
      content: `确定删除配置模板「${label}」？`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      async onOk() {
        try {
          await schedulerApi.deleteAgentConfigTemplate(template.id);
          message.success('配置模板已删除');
          await load();
        } catch (error) {
          message.error(`删除失败：${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      },
    });
  };

  const summaryColumns = useMemo<ColumnsType<AgentConfigSummary>>(
    () => [
      { title: '机台', dataIndex: 'agent_name', sorter: textSorter('agent_name'), render: (value) => value || '—' },
      { title: 'IP', dataIndex: 'agent_ip', width: 140 },
      {
        title: '状态',
        dataIndex: 'agent_status',
        width: 90,
        render: (value) => (
          <Tag color={value === 'online' ? 'success' : 'default'}>{value || '—'}</Tag>
        ),
      },
      { title: '变量', dataIndex: 'variable_count', width: 72, sorter: (a, b) => a.variable_count - b.variable_count },
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
        title: '配置更新',
        dataIndex: 'settings_updated_at',
        width: 180,
        defaultSortOrder: 'descend',
        sorter: (a, b) => timestampSorter(a.settings_updated_at, b.settings_updated_at),
        render: (value) => formatTimestamp(value),
      },
      {
        title: '数组展开',
        dataIndex: 'array_expand_mode',
        width: 100,
        render: (value) => String(value || 'semicolon'),
      },
      {
        title: '操作',
        width: 80,
        fixed: 'right',
        render: (_, row) => (
          <Button size="small" type="link" onClick={() => navigate(`/configs/${row.agent_id}`)}>
            编辑
          </Button>
        ),
      },
    ],
    [navigate],
  );

  const templateColumns = useMemo<ColumnsType<AgentConfigTemplate>>(
    () => [
      { title: 'ID', dataIndex: 'id', width: 72, sorter: (a, b) => Number(a.id) - Number(b.id) },
      { title: '名称', dataIndex: 'name', sorter: textSorter('name') },
      { title: '来源机台', dataIndex: 'source_agent_name', render: (value) => value || '—' },
      { title: '创建机台', dataIndex: 'created_by_agent_name', render: (value) => value || '—' },
      {
        title: '更新时间',
        dataIndex: 'updated_at',
        width: 180,
        defaultSortOrder: 'descend',
        sorter: (a, b) => timestampSorter(a.updated_at, b.updated_at),
        render: (value) => formatTimestamp(value),
      },
      {
        title: '操作',
        width: 160,
        fixed: 'right',
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

  const templateConfig = asRecord(templateDetail?.config);

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <PageHeader
        title={<HelpLabel label="机台配置" text={CONFIG_HELP.page} />}
        extra={
          <Button onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        }
      />

      <Card>
        <Tabs
          items={[
            {
              key: 'agents',
              label: <HelpLabel label="各机台当前配置" text={CONFIG_HELP.agentTab} />,
              children: (
                <Table
                  rowKey={(row) => row.agent_id}
                  columns={summaryColumns}
                  dataSource={summaries}
                  loading={loading}
                  locale={{ emptyText: '暂无机台配置' }}
                  pagination={DEFAULT_TABLE_PAGINATION}
                  scroll={{ x: true }}
                />
              ),
            },
            {
              key: 'templates',
              label: <HelpLabel label="中心配置模板" text={CONFIG_HELP.templateTab} />,
              children: (
                <Table
                  rowKey={(row) => String(row.id)}
                  columns={templateColumns}
                  dataSource={templates}
                  loading={loading}
                  locale={{ emptyText: '暂无配置模板' }}
                  pagination={DEFAULT_TABLE_PAGINATION}
                  scroll={{ x: true }}
                />
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title={
          templateDetail
            ? `模板详情 · ${String(templateDetail.name || '')}`
            : '模板详情'
        }
        open={templateDetailOpen}
        onCancel={closeTemplateDetail}
        footer={null}
        width={720}
        destroyOnClose
      >
        <Spin spinning={templateDetailLoading}>
          {templateDetail && !templateDetailLoading ? (
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="来源机台">
                {String(templateDetail.source_agent_name || '—')}
              </Descriptions.Item>
              <Descriptions.Item label="创建机台">
                {String(templateDetail.created_by_agent_name || '—')}
              </Descriptions.Item>
              <Descriptions.Item label="更新时间">
                {formatTimestamp(templateDetail.updated_at)}
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
        </Spin>
      </Modal>
    </Space>
  );
}
