import { App, Button, Card, Form, Input, Select, Space, Switch, Table, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { agentApi } from '../api/agentApi';
import { ApiError } from '../api/client';

type VariableRow = {
  name: string;
  value: string;
  description: string;
};

type ChannelRow = {
  id?: string | number;
  channel_index: number;
  name: string;
  enabled: boolean;
  overlay: Record<string, unknown>;
};

const getErrorMessage = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : String(error);

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function SettingsPage() {
  const { message } = App.useApp();
  const [variables, setVariables] = useState<VariableRow[]>([]);
  const [arrayExpandMode, setArrayExpandMode] = useState('off');
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [unitsText, setUnitsText] = useState('单位在中心 WebUI 维护');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [settings, channelsResp, unitsResp] = await Promise.all([
        agentApi.getSettings(),
        agentApi.getChannels(),
        agentApi.getUnits().catch(() => ({ units: [] })),
      ]);
      const settingsData = asRecord(settings);
      const vars = Array.isArray(settingsData.variables)
        ? settingsData.variables.map((item) => {
            const row = asRecord(item);
            return {
              name: String(row.name ?? ''),
              value: row.value == null ? '' : String(row.value),
              description: String(row.description ?? ''),
            };
          })
        : [];
      setVariables(vars);
      setArrayExpandMode(String(settingsData.array_expand_mode ?? 'off'));

      const channelData = asRecord(channelsResp);
      const list = Array.isArray(channelData.channels) ? channelData.channels : [];
      setChannels(
        list.map((item) => {
          const ch = asRecord(item);
          return {
            id: ch.id as string | number | undefined,
            channel_index: Number(ch.channel_index) || 0,
            name: String(ch.name ?? `CH${Number(ch.channel_index) || 0}`),
            enabled: ch.enabled !== false,
            overlay: asRecord(ch.overlay),
          };
        }),
      );

      const unitsData = asRecord(unitsResp);
      const units = Array.isArray(unitsData.units) ? unitsData.units : [];
      setUnitsText(units.length ? `中心已配置 ${units.length} 个单位（请在中心维护）` : '暂无单位（请在中心维护）');
    } catch (error) {
      message.error(`加载配置失败: ${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveSettings = async () => {
    setBusy(true);
    try {
      await agentApi.putSettings({
        variables: variables.map((v) => ({
          name: v.name.trim(),
          value: v.value,
          description: v.description,
        })),
        array_expand_mode: arrayExpandMode,
      });
      message.success(`已保存到中心 · ${variables.length} 变量`);
      await load();
    } catch (error) {
      message.error(`保存失败: ${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveChannels = async () => {
    setBusy(true);
    try {
      const data = asRecord(
        await agentApi.putChannels({
          channels: channels.map((ch) => ({
            id: ch.id,
            channel_index: ch.channel_index,
            name: ch.name,
            enabled: ch.enabled,
            overlay: ch.overlay,
          })),
        }),
      );
      const list = Array.isArray(data.channels) ? data.channels : channels;
      setChannels(
        list.map((item) => {
          const ch = asRecord(item);
          return {
            id: ch.id as string | number | undefined,
            channel_index: Number(ch.channel_index) || 0,
            name: String(ch.name ?? `CH${Number(ch.channel_index) || 0}`),
            enabled: ch.enabled !== false,
            overlay: asRecord(ch.overlay),
          };
        }),
      );
      message.success(`已保存 ${list.length} 个通道`);
    } catch (error) {
      message.error(`保存通道失败: ${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const addVariable = () => {
    setVariables((prev) => [...prev, { name: '', value: '', description: '' }]);
  };

  const addChannel = () => {
    const nextIndex = channels.reduce((max, ch) => Math.max(max, ch.channel_index), -1) + 1;
    setChannels((prev) => [
      ...prev,
      { channel_index: nextIndex, name: `CH${nextIndex}`, enabled: true, overlay: {} },
    ]);
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        配置
      </Typography.Title>

      <Card
        title="变量"
        extra={
          <Space>
            <Button onClick={addVariable}>新增变量</Button>
            <Button type="primary" loading={busy} onClick={() => void saveSettings()}>
              保存设置
            </Button>
          </Space>
        }
      >
        <Form layout="inline" style={{ marginBottom: 12 }}>
          <Form.Item label="数组展开模式">
            <Select
              style={{ width: 180 }}
              value={arrayExpandMode}
              onChange={setArrayExpandMode}
              options={[
                { value: 'off', label: 'off' },
                { value: 'zip', label: 'zip' },
                { value: 'product', label: 'product' },
              ]}
            />
          </Form.Item>
        </Form>
        <Table
          size="small"
          loading={busy}
          pagination={false}
          rowKey={(_, index) => String(index)}
          dataSource={variables}
          columns={[
            {
              title: '名称',
              render: (_, __, index) => (
                <Input
                  value={variables[index]?.name}
                  onChange={(e) => {
                    const next = variables.slice();
                    next[index] = { ...next[index], name: e.target.value };
                    setVariables(next);
                  }}
                />
              ),
            },
            {
              title: '值',
              render: (_, __, index) => (
                <Input
                  value={variables[index]?.value}
                  onChange={(e) => {
                    const next = variables.slice();
                    next[index] = { ...next[index], value: e.target.value };
                    setVariables(next);
                  }}
                />
              ),
            },
            {
              title: '说明',
              render: (_, __, index) => (
                <Input
                  value={variables[index]?.description}
                  onChange={(e) => {
                    const next = variables.slice();
                    next[index] = { ...next[index], description: e.target.value };
                    setVariables(next);
                  }}
                />
              ),
            },
            {
              title: '操作',
              width: 80,
              render: (_, __, index) => (
                <Button
                  size="small"
                  danger
                  onClick={() => setVariables((prev) => prev.filter((_, i) => i !== index))}
                >
                  删除
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Card
        title="通道"
        extra={
          <Space>
            <Button onClick={addChannel}>新增通道</Button>
            <Button type="primary" loading={busy} onClick={() => void saveChannels()}>
              保存通道
            </Button>
          </Space>
        }
      >
        <Table
          size="small"
          loading={busy}
          pagination={false}
          rowKey={(row) => String(row.channel_index)}
          dataSource={channels}
          columns={[
            { title: '索引', dataIndex: 'channel_index', width: 80 },
            {
              title: '名称',
              render: (_, __, index) => (
                <Input
                  value={channels[index]?.name}
                  onChange={(e) => {
                    const next = channels.slice();
                    next[index] = { ...next[index], name: e.target.value };
                    setChannels(next);
                  }}
                />
              ),
            },
            {
              title: '启用',
              width: 90,
              render: (_, __, index) => (
                <Switch
                  checked={channels[index]?.enabled !== false}
                  onChange={(checked) => {
                    const next = channels.slice();
                    next[index] = { ...next[index], enabled: checked };
                    setChannels(next);
                  }}
                />
              ),
            },
            {
              title: '操作',
              width: 80,
              render: (_, __, index) => (
                <Button
                  size="small"
                  danger
                  onClick={() => setChannels((prev) => prev.filter((_, i) => i !== index))}
                >
                  删除
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Card title="单位">
        <Typography.Text type="secondary">{unitsText}</Typography.Text>
      </Card>
    </Space>
  );
}
