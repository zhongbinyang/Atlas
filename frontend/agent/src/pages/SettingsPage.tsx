import {
  Alert,
  App,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { REFRESH_LABEL } from '../lib/uiCopy';
import { agentApi } from '../api/agentApi';
import { ApiError } from '../api/client';
import { CollapsibleCard } from '../components/CollapsibleCard';
import { PageHeader } from '../components/PageHeader';
import { centerConfigsPageUrl } from '../utils/centerUrl';
import {
  type ConfigProfile,
  activeProfileName,
  isSystemVarName,
  normalizeArrayExpandMode,
  normalizeConfigProfile,
  overlayObjectFromUnknown,
} from './settingsModels';

type VariableRow = {
  name: string;
  value: string;
  description: string;
  system?: boolean;
};

type OverlayPair = { key: string; value: string };

type ChannelRow = {
  id?: string | number;
  channel_index: number;
  name: string;
  enabled: boolean;
  overlayPairs: OverlayPair[];
};

type UnitRow = {
  symbol: string;
  description: string;
};

type ConfigTemplateRow = {
  id: string | number;
  name: string;
  note?: string;
  source_agent_name?: string;
  created_by_agent_name?: string;
  updated_at?: string;
};

const formatTemplateTime = (value?: string) => {
  if (!value) return '—';
  return value.replace('T', ' ').replace(/\.\d+Z$/, '').slice(0, 19);
};

const buildDefaultTemplateName = (hostname: string) => {
  const label = hostname.trim() || '机台';
  const date = new Date().toISOString().slice(0, 10);
  return `${label}-${date}`;
};

const getErrorMessage = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : String(error);

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const pairsFromOverlay = (overlay: Record<string, string>): OverlayPair[] => {
  const keys = Object.keys(overlay);
  if (!keys.length) return [{ key: '', value: '' }];
  return keys.map((key) => ({ key, value: overlay[key] ?? '' }));
};

const overlayFromPairs = (pairs: OverlayPair[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (!key) continue;
    out[key] = pair.value;
  }
  return out;
};

function ReadOnlyProfileTable({
  title,
  profiles,
}: {
  title: string;
  profiles: ConfigProfile[];
}) {
  const current = activeProfileName(profiles);
  return (
    <CollapsibleCard title={title} extra={current ? <Tag color="success">{current}</Tag> : null}>
      <Table
        size="small"
        pagination={false}
        locale={{ emptyText: '暂无配置档' }}
        rowKey={(row) => row.id || row.name}
        dataSource={profiles}
        columns={[
          { title: '名称', dataIndex: 'name', ellipsis: true },
          {
            title: '状态',
            dataIndex: 'is_active',
            width: 90,
            render: (active: boolean) => (active ? <Tag color="success">当前</Tag> : <Tag>备用</Tag>),
          },
          { title: '来源文件', dataIndex: 'source_filename', ellipsis: true },
        ]}
      />
    </CollapsibleCard>
  );
}

export function SettingsPage() {
  const { message, modal } = App.useApp();
  const [variables, setVariables] = useState<VariableRow[]>([]);
  const [arrayExpandMode, setArrayExpandMode] = useState<'semicolon' | 'json'>('semicolon');
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [configTemplates, setConfigTemplates] = useState<ConfigTemplateRow[]>([]);
  const [deviceProfiles, setDeviceProfiles] = useState<ConfigProfile[]>([]);
  const [calibrationProfiles, setCalibrationProfiles] = useState<ConfigProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveTemplateName, setSaveTemplateName] = useState('');
  const [saveTemplateNote, setSaveTemplateNote] = useState('');
  const [agentHostname, setAgentHostname] = useState('');
  const [centerUrl, setCenterUrl] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirtyBlocks, setDirtyBlocks] = useState({
    variables: false,
    channels: false,
  });

  const hasUnsavedEdits = useMemo(
    () => Object.values(dirtyBlocks).some(Boolean),
    [dirtyBlocks],
  );

  const clearDirtyBlocks = () => {
    setDirtyBlocks({
      variables: false,
      channels: false,
    });
  };

  const markVariablesDirty = () => {
    setDirtyBlocks((prev) => (prev.variables ? prev : { ...prev, variables: true }));
  };

  const markChannelsDirty = () => {
    setDirtyBlocks((prev) => (prev.channels ? prev : { ...prev, channels: true }));
  };

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [settings, channelsResp, unitsResp, deviceList, calibrationList, status] = await Promise.all([
        agentApi.getSettings(),
        agentApi.getChannels(),
        agentApi.getUnits().catch(() => ({ units: [] })),
        agentApi.listDeviceProfiles().catch(() => []),
        agentApi.listCalibrationProfiles().catch(() => []),
        agentApi.status().catch(() => null),
      ]);
      setCenterUrl(status?.center_url ?? '');
      const settingsData = asRecord(settings);
      const vars = Array.isArray(settingsData.variables)
        ? settingsData.variables.map((item) => {
            const row = asRecord(item);
            const name = String(row.name ?? '');
            return {
              name,
              value: row.value == null ? '' : String(row.value),
              description: String(row.description ?? ''),
              system: isSystemVarName(name),
            };
          })
        : [];
      setVariables(vars);
      setArrayExpandMode(normalizeArrayExpandMode(settingsData.array_expand_mode));

      const fromSettingsDevice = Array.isArray(settingsData.device_profiles)
        ? settingsData.device_profiles.map(normalizeConfigProfile)
        : [];
      const fromSettingsCal = Array.isArray(settingsData.calibration_profiles)
        ? settingsData.calibration_profiles.map(normalizeConfigProfile)
        : [];
      setDeviceProfiles(
        (Array.isArray(deviceList) && deviceList.length
          ? deviceList
          : fromSettingsDevice
        ).map(normalizeConfigProfile),
      );
      setCalibrationProfiles(
        (Array.isArray(calibrationList) && calibrationList.length
          ? calibrationList
          : fromSettingsCal
        ).map(normalizeConfigProfile),
      );

      const channelData = asRecord(channelsResp);
      const list = Array.isArray(channelData.channels) ? channelData.channels : [];
      setChannels(
        list
          .map((item) => {
            const ch = asRecord(item);
            const overlay = overlayObjectFromUnknown(ch.overlay);
            return {
              id: ch.id as string | number | undefined,
              channel_index: Number(ch.channel_index) || 0,
              name: String(ch.name ?? `CH${Number(ch.channel_index) || 0}`),
              enabled: ch.enabled !== false,
              overlayPairs: pairsFromOverlay(overlay),
            };
          })
          .sort((a, b) => a.channel_index - b.channel_index),
      );

      const unitsData = asRecord(unitsResp);
      const unitsList = Array.isArray(unitsData.units)
        ? unitsData.units
        : Array.isArray(settingsData.units)
          ? settingsData.units
          : [];
      setUnits(
        unitsList.map((item) => {
          if (typeof item === 'string') return { symbol: item, description: '' };
          const row = asRecord(item);
          return {
            symbol: String(row.symbol ?? ''),
            description: String(row.description ?? ''),
          };
        }),
      );

      const templates = await agentApi.listAgentConfigTemplates().catch(() => []);
      setConfigTemplates(
        templates.map((item) => {
          const row = asRecord(item);
          return {
            id: row.id as string | number,
            name: String(row.name ?? row.id ?? ''),
            note: row.note != null ? String(row.note) : undefined,
            source_agent_name:
              row.source_agent_name != null ? String(row.source_agent_name) : undefined,
            created_by_agent_name:
              row.created_by_agent_name != null ? String(row.created_by_agent_name) : undefined,
            updated_at: row.updated_at != null ? String(row.updated_at) : undefined,
          };
        }),
      );
      clearDirtyBlocks();
      setLoadError(null);
    } catch (error) {
      const detail = getErrorMessage(error);
      setLoadError(detail);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void agentApi
      .status()
      .then((status) => setAgentHostname(status.hostname || ''))
      .catch(() => {});
  }, []);

  const configsUrl = centerConfigsPageUrl(centerUrl);

  const configSnapshotSummary = useMemo(() => {
    const enabledChannels = channels.filter((ch) => ch.enabled).length;
    return `变量 ${variables.length} · 设备档 ${deviceProfiles.length} · 校准档 ${calibrationProfiles.length} · 通道 ${channels.length}（启用 ${enabledChannels}）· 单位 ${units.length}`;
  }, [variables.length, deviceProfiles.length, calibrationProfiles.length, channels, units.length]);

  const requestReload = () => {
    if (!hasUnsavedEdits) {
      void load();
      return;
    }
    modal.confirm({
      title: '放弃未保存的更改？',
      content: '刷新将丢弃变量与通道等未保存的编辑。',
      okText: REFRESH_LABEL,
      okType: 'danger',
      cancelText: '取消',
      onOk: () => load(),
    });
  };

  const openSaveModal = () => {
    setSaveTemplateName(buildDefaultTemplateName(agentHostname));
    setSaveTemplateNote('');
    setSaveModalOpen(true);
  };

  const confirmSaveTemplate = async () => {
    const name = saveTemplateName.trim();
    if (!name) {
      message.warning('请输入模板名称');
      return;
    }
    setBusy(true);
    try {
      await agentApi.saveAgentConfigTemplate({
        name,
        note: saveTemplateNote.trim() || undefined,
      });
      message.success('已保存为中心配置模板');
      setSaveModalOpen(false);
      await load();
    } catch (error) {
      message.error(`保存模板失败: ${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const loadConfigTemplate = (template: ConfigTemplateRow) => {
    modal.confirm({
      title: '加载中心配置模板',
      content: (
        <div>
          <p style={{ marginBottom: 8 }}>
            将用模板「<strong>{template.name}</strong>」覆盖本机当前配置。
          </p>
          <Typography.Text type="secondary">
            变量、设备档、校准档与通道将被替换；Hostname / IP 保留本机值。
          </Typography.Text>
        </div>
      ),
      okText: '加载并覆盖',
      cancelText: '取消',
      async onOk() {
        setBusy(true);
        try {
          await agentApi.loadAgentConfigTemplate(template.id);
          message.success('已加载配置模板到本机');
          await load();
        } catch (error) {
          message.error(`加载失败: ${getErrorMessage(error)}`);
        } finally {
          setBusy(false);
        }
      },
    });
  };

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
      message.success(`已保存 · ${variables.length} 个变量`);
      setDirtyBlocks((prev) => ({ ...prev, variables: false }));
      await load();
    } catch (error) {
      message.error(`保存失败: ${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveChannels = async () => {
    const indexes = channels.map((ch) => ch.channel_index);
    if (new Set(indexes).size !== indexes.length) {
      message.error('通道索引不能重复');
      return;
    }
    setBusy(true);
    try {
      const data = asRecord(
        await agentApi.putChannels({
          channels: channels.map((ch) => ({
            id: ch.id,
            channel_index: ch.channel_index,
            name: ch.name,
            enabled: ch.enabled,
            overlay: overlayFromPairs(ch.overlayPairs),
          })),
        }),
      );
      const list = Array.isArray(data.channels) ? data.channels : channels;
      setChannels(
        list
          .map((item) => {
            const ch = asRecord(item);
            return {
              id: ch.id as string | number | undefined,
              channel_index: Number(ch.channel_index) || 0,
              name: String(ch.name ?? `CH${Number(ch.channel_index) || 0}`),
              enabled: ch.enabled !== false,
              overlayPairs: pairsFromOverlay(overlayObjectFromUnknown(ch.overlay)),
            };
          })
          .sort((a, b) => a.channel_index - b.channel_index),
      );
      message.success(`已保存 ${list.length} 个通道`);
      setDirtyBlocks((prev) => ({ ...prev, channels: false }));
    } catch (error) {
      message.error(`保存通道失败: ${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const addVariable = () => {
    markVariablesDirty();
    setVariables((prev) => [...prev, { name: '', value: '', description: '' }]);
  };

  const addChannel = () => {
    markChannelsDirty();
    const nextIndex = channels.reduce((max, ch) => Math.max(max, ch.channel_index), -1) + 1;
    setChannels((prev) => [
      ...prev,
      {
        channel_index: nextIndex,
        name: `CH${nextIndex}`,
        enabled: true,
        overlayPairs: [{ key: '', value: '' }],
      },
    ]);
  };

  return (
    <div className="atlas-page">
      <PageHeader
        title="配置"
        description="手工变量、设备/校准配置档、通道 overlay 与中心单位。展开优先级：通道 overlay > 手工变量 > 设备档 > 校准档。"
        extra={
          <Button onClick={requestReload} loading={busy}>
            {REFRESH_LABEL}
          </Button>
        }
      />

      <Alert
        type="info"
        showIcon
        message="设备与校验配置在中心维护"
        description={
          configsUrl ? (
            <a href={configsUrl} target="_blank" rel="noreferrer">
              打开中心机台配置
            </a>
          ) : (
            '未配置 AGENT_CENTER_URL，无法打开中心。'
          )
        }
      />

      {loadError ? (
        <Alert
          type="error"
          showIcon
          message="加载配置失败"
          description={loadError}
          action={
            <Button size="small" onClick={() => void load()}>
              重试
            </Button>
          }
        />
      ) : null}

      {hasUnsavedEdits ? (
        <Alert type="warning" showIcon message="有未保存的更改，离开或刷新前请先保存。" />
      ) : null}

      <CollapsibleCard
        title="中心配置模板"
        defaultOpen
        extra={
          <Button type="primary" disabled={busy} onClick={openSaveModal}>
            保存为模板
          </Button>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          「保存为模板」从当前机台配置拍快照；「加载」会覆盖本机变量、设备档、校准档与通道（Hostname / IP 保留本机值）。
        </Typography.Paragraph>
        <Table
          size="small"
          loading={busy}
          rowKey={(row) => String(row.id)}
          dataSource={configTemplates}
          pagination={{ pageSize: 6, showSizeChanger: false }}
          locale={{ emptyText: '暂无中心配置模板' }}
          columns={[
            { title: 'ID', dataIndex: 'id', width: 72 },
            {
              title: '名称',
              dataIndex: 'name',
              ellipsis: true,
              render: (name: string, row) => (
                <Space direction="vertical" size={0}>
                  <span>{name}</span>
                  {row.note ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {row.note}
                    </Typography.Text>
                  ) : null}
                </Space>
              ),
            },
            {
              title: '来源机台',
              dataIndex: 'source_agent_name',
              width: 120,
              ellipsis: true,
              render: (value?: string) => value || '—',
            },
            {
              title: '创建者',
              dataIndex: 'created_by_agent_name',
              width: 100,
              ellipsis: true,
              render: (value?: string) => value || '—',
            },
            {
              title: '更新时间',
              dataIndex: 'updated_at',
              width: 160,
              render: (value?: string) => formatTemplateTime(value),
            },
            {
              title: '操作',
              width: 80,
              render: (_, row) => (
                <Button size="small" type="link" disabled={busy} onClick={() => loadConfigTemplate(row)}>
                  加载
                </Button>
              ),
            },
          ]}
        />
      </CollapsibleCard>

      <Modal
        title="保存为中心配置模板"
        open={saveModalOpen}
        okText="保存"
        cancelText="取消"
        confirmLoading={busy}
        onOk={() => void confirmSaveTemplate()}
        onCancel={() => setSaveModalOpen(false)}
        destroyOnClose
      >
        <Form layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="模板名称" required>
            <Input
              value={saveTemplateName}
              onChange={(event) => setSaveTemplateName(event.target.value)}
              placeholder="例如：机台A-2026-08-09"
              maxLength={120}
              onPressEnter={() => void confirmSaveTemplate()}
            />
          </Form.Item>
          <Form.Item label="备注（可选）">
            <Input.TextArea
              value={saveTemplateNote}
              onChange={(event) => setSaveTemplateNote(event.target.value)}
              placeholder="用途、适用批次等"
              rows={2}
              maxLength={500}
            />
          </Form.Item>
          <Form.Item label="当前配置快照">
            <Typography.Text type="secondary">{configSnapshotSummary}</Typography.Text>
          </Form.Item>
        </Form>
      </Modal>

      <CollapsibleCard
        title="手工变量"
        extra={
          <Space>
            <Button onClick={addVariable}>新增</Button>
            <Button type="primary" loading={busy} onClick={() => void saveSettings()}>
              保存变量
            </Button>
          </Space>
        }
      >
        <Form layout="inline" style={{ marginBottom: 16 }}>
          <Form.Item label="数组展开模式">
            <Select
              style={{ width: 280 }}
              value={arrayExpandMode}
              onChange={(value) => {
                markVariablesDirty();
                setArrayExpandMode(value);
              }}
              options={[
                { value: 'semicolon', label: 'semicolon · 4.58;4.5;4.6' },
                { value: 'json', label: 'json · [4.58,4.5,4.6]' },
              ]}
            />
          </Form.Item>
        </Form>
        <Table
          size="middle"
          loading={busy}
          pagination={false}
          locale={{ emptyText: '暂无变量，点击「新增」添加' }}
          rowKey={(_, index) => String(index)}
          dataSource={variables}
          columns={[
            {
              title: '名称',
              width: 220,
              render: (_, row, index) =>
                row.system ? (
                  <Space>
                    <Typography.Text code>{`\${${row.name}}`}</Typography.Text>
                    <Tag>系统</Tag>
                  </Space>
                ) : (
                  <Input
                    addonBefore="$"
                    value={variables[index]?.name}
                    placeholder="变量名"
                    onChange={(e) => {
                      const next = variables.slice();
                      next[index] = { ...next[index], name: e.target.value };
                      markVariablesDirty();
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
                  placeholder="值"
                  onChange={(e) => {
                    const next = variables.slice();
                    next[index] = { ...next[index], value: e.target.value };
                    markVariablesDirty();
                    setVariables(next);
                  }}
                />
              ),
            },
            {
              title: '说明',
              render: (_, row, index) => (
                <Input
                  value={variables[index]?.description}
                  disabled={row.system}
                  placeholder="可选说明"
                  onChange={(e) => {
                    const next = variables.slice();
                    next[index] = { ...next[index], description: e.target.value };
                    markVariablesDirty();
                    setVariables(next);
                  }}
                />
              ),
            },
            {
              title: '操作',
              width: 80,
              render: (_, row, index) =>
                row.system ? null : (
                  <Button
                    size="small"
                    type="link"
                    danger
                    onClick={() => {
                      markVariablesDirty();
                      setVariables((prev) => prev.filter((_, i) => i !== index));
                    }}
                  >
                    删除
                  </Button>
                ),
            },
          ]}
        />
      </CollapsibleCard>

      <ReadOnlyProfileTable title="设备配置档" profiles={deviceProfiles} />

      <ReadOnlyProfileTable title="校准配置档" profiles={calibrationProfiles} />

      <CollapsibleCard
        title="通道"
        extra={
          <Space>
            <Button onClick={addChannel}>新增</Button>
            <Button type="primary" loading={busy} onClick={() => void saveChannels()}>
              保存通道
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          overlay 值为字符串；空通道表时序列运行使用合成 CH0。
        </Typography.Paragraph>
        <Table
          size="middle"
          loading={busy}
          pagination={false}
          locale={{ emptyText: '暂无通道，点击「新增」添加（或依赖合成 CH0）' }}
          rowKey={(row) => String(row.id ?? row.channel_index)}
          dataSource={channels}
          columns={[
            {
              title: '索引',
              width: 90,
              render: (_, __, index) => (
                <Input
                  type="number"
                  value={channels[index]?.channel_index}
                  onChange={(e) => {
                    const next = channels.slice();
                    next[index] = {
                      ...next[index],
                      channel_index: Number(e.target.value) || 0,
                    };
                    markChannelsDirty();
                    setChannels(next);
                  }}
                />
              ),
            },
            {
              title: '名称',
              width: 140,
              render: (_, __, index) => (
                <Input
                  value={channels[index]?.name}
                  onChange={(e) => {
                    const next = channels.slice();
                    next[index] = { ...next[index], name: e.target.value };
                    markChannelsDirty();
                    setChannels(next);
                  }}
                />
              ),
            },
            {
              title: '启用',
              width: 80,
              render: (_, __, index) => (
                <Switch
                  checked={channels[index]?.enabled !== false}
                  onChange={(checked) => {
                    const next = channels.slice();
                    next[index] = { ...next[index], enabled: checked };
                    markChannelsDirty();
                    setChannels(next);
                  }}
                />
              ),
            },
            {
              title: 'Overlay',
              render: (_, row, channelIndex) => (
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  {row.overlayPairs.map((pair, pairIndex) => (
                    <Space key={pairIndex} wrap>
                      <Input
                        className="atlas-mono-textarea"
                        placeholder="键"
                        value={pair.key}
                        style={{ width: 160 }}
                        onChange={(e) => {
                          const next = channels.slice();
                          const pairs = next[channelIndex].overlayPairs.slice();
                          pairs[pairIndex] = { ...pairs[pairIndex], key: e.target.value };
                          next[channelIndex] = { ...next[channelIndex], overlayPairs: pairs };
                          markChannelsDirty();
                          setChannels(next);
                        }}
                      />
                      <Input
                        className="atlas-mono-textarea"
                        placeholder="值"
                        value={pair.value}
                        style={{ width: 180 }}
                        onChange={(e) => {
                          const next = channels.slice();
                          const pairs = next[channelIndex].overlayPairs.slice();
                          pairs[pairIndex] = { ...pairs[pairIndex], value: e.target.value };
                          next[channelIndex] = { ...next[channelIndex], overlayPairs: pairs };
                          markChannelsDirty();
                          setChannels(next);
                        }}
                      />
                      <Button
                        size="small"
                        onClick={() => {
                          const next = channels.slice();
                          let pairs = next[channelIndex].overlayPairs.filter((_, i) => i !== pairIndex);
                          if (!pairs.length) pairs = [{ key: '', value: '' }];
                          next[channelIndex] = { ...next[channelIndex], overlayPairs: pairs };
                          markChannelsDirty();
                          setChannels(next);
                        }}
                      >
                        ×
                      </Button>
                    </Space>
                  ))}
                  <Button
                    size="small"
                    onClick={() => {
                      const next = channels.slice();
                      next[channelIndex] = {
                        ...next[channelIndex],
                        overlayPairs: [...next[channelIndex].overlayPairs, { key: '', value: '' }],
                      };
                      markChannelsDirty();
                      setChannels(next);
                    }}
                  >
                    + 键
                  </Button>
                </Space>
              ),
            },
            {
              title: '操作',
              width: 80,
              render: (_, __, index) => (
                <Button
                  size="small"
                  type="link"
                  danger
                  onClick={() => {
                    markChannelsDirty();
                    setChannels((prev) => prev.filter((_, i) => i !== index));
                  }}
                >
                  删除
                </Button>
              ),
            },
          ]}
        />
      </CollapsibleCard>

      <CollapsibleCard title="单位（中心只读）" size="small">
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          单位在中心 WebUI 维护；此处供 Spec 下拉复用。
        </Typography.Paragraph>
        <Table
          size="small"
          pagination={{ pageSize: 8, showSizeChanger: false }}
          locale={{ emptyText: '暂无单位' }}
          rowKey={(row) => row.symbol}
          dataSource={units}
          columns={[
            { title: '符号', dataIndex: 'symbol', width: 100 },
            { title: '说明', dataIndex: 'description' },
          ]}
        />
      </CollapsibleCard>
    </div>
  );
}
