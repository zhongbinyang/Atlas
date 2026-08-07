import { App as AntApp, Button, Card, Modal, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { schedulerApi } from '../api/schedulerApi';
import type { SequenceTemplate } from '../api/types';

export function SequencesPage() {
  const { message } = AntApp.useApp();
  const [templates, setTemplates] = useState<SequenceTemplate[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const nextTemplates = await schedulerApi.listSequenceTemplates();
      setTemplates(Array.isArray(nextTemplates) ? nextTemplates : []);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      message.error('加载序列模板失败：' + detail);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const deleteTemplate = useCallback(
    (template: SequenceTemplate) => {
      const label = template.name || String(template.id || '此模板');
      Modal.confirm({
        title: '确认删除',
        content: '确定删除「序列模板「' + label + '」」？',
        okText: '删除',
        okType: 'danger',
        cancelText: '取消',
        async onOk() {
          await schedulerApi.deleteSequenceTemplate(template.id);
          message.success('序列模板已删除');
          await load();
        },
      });
    },
    [load, message],
  );

  const columns = useMemo<ColumnsType<SequenceTemplate>>(
    () => [
      { title: 'ID', dataIndex: 'id', render: (value) => <Typography.Text code>{String(value)}</Typography.Text> },
      { title: '名称', dataIndex: 'name', render: (value) => value || '—' },
      {
        title: '步骤数',
        dataIndex: 'step_count',
        render: (value) => (typeof value === 'number' ? value : Number(value || 0)),
      },
      { title: '来源机台', dataIndex: 'created_by_agent_name', render: (value) => value || '—' },
      {
        title: '操作',
        render: (_, record) => (
          <Button danger size="small" onClick={() => deleteTemplate(record)}>
            删除
          </Button>
        ),
      },
    ],
    [deleteTemplate],
  );

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          序列模板
        </Typography.Title>
        <Button onClick={() => void load()} loading={loading}>
          刷新
        </Button>
      </Space>

      <Card>
        <Table
          rowKey={(record) => String(record.id)}
          columns={columns}
          dataSource={templates}
          loading={loading}
          locale={{ emptyText: '暂无序列模板' }}
          pagination={false}
          scroll={{ x: true }}
        />
      </Card>
    </Space>
  );
}
