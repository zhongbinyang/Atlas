import { App, Button, Card, Form, Input, InputNumber, Space, Table, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { agentApi } from '../api/agentApi';
import { ApiError } from '../api/client';

type GeneralTemplate = {
  id?: string | number;
  name?: string;
  kind?: string;
  origin_agent_name?: string;
  inputs?: unknown;
};

const getErrorMessage = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : String(error);

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function GeneralPage() {
  const { message } = App.useApp();
  const [delayMs, setDelayMs] = useState<number | null>(1000);
  const [delayName, setDelayName] = useState('');
  const [delayOut, setDelayOut] = useState('');
  const [delayBusy, setDelayBusy] = useState(false);
  const [versionName, setVersionName] = useState('');
  const [versionOut, setVersionOut] = useState('');
  const [versionCurrent, setVersionCurrent] = useState('');
  const [versionBusy, setVersionBusy] = useState(false);
  const [templates, setTemplates] = useState<GeneralTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);

  const loadTemplates = useCallback(async () => {
    setLoadingTemplates(true);
    try {
      const data = await agentApi.generalAllTemplates();
      setTemplates(Array.isArray(data) ? (data as GeneralTemplate[]) : []);
    } catch (error) {
      message.error(`加载通用功能失败: ${getErrorMessage(error)}`);
    } finally {
      setLoadingTemplates(false);
    }
  }, [message]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  const runDelay = async () => {
    if (delayMs == null || !Number.isFinite(delayMs) || delayMs < 0) {
      message.error('请输入有效的延迟毫秒数');
      return;
    }
    setDelayBusy(true);
    setDelayOut('…');
    try {
      const data = await agentApi.delayRun({ delay_ms: Math.round(delayMs) });
      setDelayOut(JSON.stringify(data, null, 2));
      message.success('试跑完成');
    } catch (error) {
      setDelayOut(getErrorMessage(error));
      message.error(`试跑失败: ${getErrorMessage(error)}`);
    } finally {
      setDelayBusy(false);
    }
  };

  const registerDelay = async () => {
    const name = delayName.trim();
    if (!name) {
      message.error('名称不能为空');
      return;
    }
    if (delayMs == null || !Number.isFinite(delayMs) || delayMs < 0) {
      message.error('请输入有效的延迟毫秒数');
      return;
    }
    setDelayBusy(true);
    try {
      const data = asRecord(await agentApi.delayRegister({ name, delay_ms: Math.round(delayMs) }));
      message.success(`已注册: ${String(data.name ?? name)} (ID ${String(data.id ?? '—')})`);
      await loadTemplates();
    } catch (error) {
      message.error(`注册失败: ${getErrorMessage(error)}`);
    } finally {
      setDelayBusy(false);
    }
  };

  const runVersion = async () => {
    setVersionBusy(true);
    setVersionOut('…');
    try {
      const data = asRecord(await agentApi.versionRun());
      setVersionOut(JSON.stringify(data, null, 2));
      if (data.version != null) setVersionCurrent(String(data.version));
      message.success(data.version != null ? `试跑完成：${String(data.version)}` : '试跑完成');
    } catch (error) {
      setVersionOut(getErrorMessage(error));
      message.error(`试跑失败: ${getErrorMessage(error)}`);
    } finally {
      setVersionBusy(false);
    }
  };

  const registerVersion = async () => {
    const name = versionName.trim();
    if (!name) {
      message.error('名称不能为空');
      return;
    }
    setVersionBusy(true);
    try {
      const data = asRecord(await agentApi.versionRegister({ name }));
      message.success(`已注册: ${String(data.name ?? name)} (ID ${String(data.id ?? '—')})`);
      await loadTemplates();
    } catch (error) {
      message.error(`注册失败: ${getErrorMessage(error)}`);
    } finally {
      setVersionBusy(false);
    }
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        通用
      </Typography.Title>

      <Card title="延迟">
        <Form layout="inline">
          <Form.Item label="延迟毫秒">
            <InputNumber min={0} value={delayMs ?? undefined} onChange={(v) => setDelayMs(v)} />
          </Form.Item>
          <Form.Item label="注册名称">
            <Input value={delayName} onChange={(e) => setDelayName(e.target.value)} style={{ width: 200 }} />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" loading={delayBusy} onClick={() => void runDelay()}>
                试跑
              </Button>
              <Button loading={delayBusy} onClick={() => void registerDelay()}>
                注册到中心
              </Button>
            </Space>
          </Form.Item>
        </Form>
        {delayOut ? (
          <Typography.Paragraph>
            <pre style={{ marginTop: 12 }}>{delayOut}</pre>
          </Typography.Paragraph>
        ) : null}
      </Card>

      <Card title="版本">
        <Form layout="inline">
          <Form.Item label="注册名称">
            <Input value={versionName} onChange={(e) => setVersionName(e.target.value)} style={{ width: 200 }} />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" loading={versionBusy} onClick={() => void runVersion()}>
                试跑
              </Button>
              <Button loading={versionBusy} onClick={() => void registerVersion()}>
                注册到中心
              </Button>
            </Space>
          </Form.Item>
        </Form>
        {versionCurrent ? <Typography.Text type="secondary">当前版本：{versionCurrent}</Typography.Text> : null}
        {versionOut ? (
          <Typography.Paragraph>
            <pre style={{ marginTop: 12 }}>{versionOut}</pre>
          </Typography.Paragraph>
        ) : null}
      </Card>

      <Card
        title="中心通用功能"
        extra={
          <Button onClick={() => void loadTemplates()} loading={loadingTemplates}>
            刷新
          </Button>
        }
      >
        <Table
          rowKey={(row) => String(row.id ?? row.name)}
          loading={loadingTemplates}
          dataSource={templates}
          pagination={false}
          columns={[
            { title: 'ID', dataIndex: 'id', width: 80 },
            { title: '名称', dataIndex: 'name' },
            { title: '类型', dataIndex: 'kind', width: 100 },
            { title: '来源机台', dataIndex: 'origin_agent_name' },
          ]}
        />
      </Card>
    </Space>
  );
}
