import {
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
  Upload,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { agentApi } from '../api/agentApi';
import { ApiError } from '../api/client';
import { CollapsibleCard } from '../components/CollapsibleCard';
import { PageHeader } from '../components/PageHeader';
import { centerConfigsPageUrl } from '../utils/centerUrl';
import {
  type ConfigProfile,
  type FlatPreviewRow,
  flatRowsToSetting,
  isSystemVarName,
  normalizeArrayExpandMode,
  normalizeConfigProfile,
  overlayObjectFromUnknown,
  settingToFlatPreviewRows,
  textToSettingJson,
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

type ProfileKind = 'device' | 'calibration';

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

function ProfileSection({
  kind,
  title,
  profiles,
  busy,
  onRefresh,
}: {
  kind: ProfileKind;
  title: string;
  profiles: ConfigProfile[];
  busy: boolean;
  onRefresh: () => Promise<void>;
}) {
  const { message, modal } = App.useApp();
  const [flatRows, setFlatRows] = useState<FlatPreviewRow[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importName, setImportName] = useState('');
  const [importFilename, setImportFilename] = useState('');
  const [importSetting, setImportSetting] = useState<Record<string, unknown>>({});
  const [importPreviewRows, setImportPreviewRows] = useState<FlatPreviewRow[]>([]);
  const [importActivate, setImportActivate] = useState(true);
  const [viewOpen, setViewOpen] = useState(false);
  const [viewProfile, setViewProfile] = useState<ConfigProfile | null>(null);
  const [savingFlat, setSavingFlat] = useState(false);

  const active = useMemo(() => profiles.find((p) => p.is_active) || null, [profiles]);

  useEffect(() => {
    setFlatRows(active ? settingToFlatPreviewRows(active.setting) : []);
  }, [active]);

  const createProfile = kind === 'device' ? agentApi.createDeviceProfile : agentApi.createCalibrationProfile;
  const updateProfile = kind === 'device' ? agentApi.updateDeviceProfile : agentApi.updateCalibrationProfile;
  const deleteProfile = kind === 'device' ? agentApi.deleteDeviceProfile : agentApi.deleteCalibrationProfile;
  const activateProfile =
    kind === 'device' ? agentApi.activateDeviceProfile : agentApi.activateCalibrationProfile;

  const openImportFromText = (text: string, filename: string) => {
    const parsed = textToSettingJson(text, filename);
    const base = filename.replace(/\.[^.]+$/, '') || (kind === 'calibration' ? 'Calibration' : 'Device');
    setImportFilename(filename);
    setImportName(base);
    setImportSetting(parsed.setting);
    setImportPreviewRows(parsed.rows);
    setImportActivate(true);
    setImportOpen(true);
  };

  const confirmImport = async () => {
    const name = importName.trim();
    if (!name) {
      message.error('请填写配置档名称');
      return;
    }
    try {
      await createProfile({
        name,
        setting: importSetting,
        source_filename: importFilename,
        activate: importActivate,
      });
      message.success(`已导入${kind === 'calibration' ? '校准' : '设备'}配置档`);
      setImportOpen(false);
      await onRefresh();
    } catch (error) {
      message.error(`导入失败: ${getErrorMessage(error)}`);
    }
  };

  const saveFlat = async () => {
    if (!active?.id) {
      message.warning(`没有当前启用的${kind === 'calibration' ? '校准' : '设备'}配置档`);
      return;
    }
    setSavingFlat(true);
    try {
      await updateProfile(active.id, {
        name: active.name,
        setting: flatRowsToSetting(flatRows, active.setting),
        source_filename: active.source_filename || '',
      });
      message.success('已保存当前配置档扁平值');
      await onRefresh();
    } catch (error) {
      message.error(`保存失败: ${getErrorMessage(error)}`);
    } finally {
      setSavingFlat(false);
    }
  };

  return (
    <CollapsibleCard
      title={title}
      extra={
        <Space wrap>
          <Upload
            accept=".ini,.toml,text/plain"
            showUploadList={false}
            beforeUpload={(file) => {
              const reader = new FileReader();
              reader.onload = () => {
                openImportFromText(String(reader.result || ''), file.name);
              };
              reader.readAsText(file);
              return false;
            }}
          >
            <Button disabled={busy}>导入 INI/TOML</Button>
          </Upload>
          <Button disabled={busy || !active} loading={savingFlat} type="primary" onClick={() => void saveFlat()}>
            保存当前扁平值
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        运行时展开为 <Typography.Text code>${'{Section_Key}'}</Typography.Text>
        ；手工变量与通道 overlay 优先级更高。
      </Typography.Paragraph>

      <Table
        size="small"
        pagination={false}
        locale={{ emptyText: '暂无配置档，请导入' }}
        rowKey={(row) => row.id || row.name}
        dataSource={profiles}
        columns={[
          { title: '名称', dataIndex: 'name', ellipsis: true },
          {
            title: '状态',
            width: 90,
            render: (_, row) => (row.is_active ? <Tag color="success">当前</Tag> : <Tag>备用</Tag>),
          },
          { title: '来源文件', dataIndex: 'source_filename', ellipsis: true },
          {
            title: '操作',
            width: 220,
            render: (_, row) => (
              <Space wrap size={0}>
                {!row.is_active ? (
                  <Button
                    size="small"
                    type="link"
                    disabled={busy || !row.id}
                    onClick={() => {
                      void (async () => {
                        try {
                          await activateProfile(row.id);
                          message.success(`已启用：${row.name}`);
                          await onRefresh();
                        } catch (error) {
                          message.error(`启用失败: ${getErrorMessage(error)}`);
                        }
                      })();
                    }}
                  >
                    启用
                  </Button>
                ) : null}
                <Button
                  size="small"
                  type="link"
                  onClick={() => {
                    setViewProfile(row);
                    setViewOpen(true);
                  }}
                >
                  查看
                </Button>
                <Button
                  size="small"
                  type="link"
                  danger
                  disabled={busy || !row.id}
                  onClick={() => {
                    modal.confirm({
                      title: `删除配置档「${row.name}」？`,
                      okText: '删除',
                      okButtonProps: { danger: true },
                      async onOk() {
                        await deleteProfile(row.id);
                        message.success('已删除');
                        await onRefresh();
                      },
                    });
                  }}
                >
                  删除
                </Button>
              </Space>
            ),
          },
        ]}
      />

      <Typography.Title level={5} style={{ marginTop: 16 }}>
        当前启用扁平预览{active ? ` · ${active.name}` : ''}
      </Typography.Title>
      {!active ? (
        <Typography.Text type="secondary">尚未启用配置档</Typography.Text>
      ) : (
        <Table
          size="small"
          pagination={false}
          rowKey={(row) => row.flatName}
          dataSource={flatRows}
          locale={{ emptyText: '当前配置档无有效键' }}
          columns={[
            {
              title: '变量',
              width: 220,
              render: (_, row) => <Typography.Text code>{`\${${row.flatName}}`}</Typography.Text>,
            },
            {
              title: '值',
              render: (_, row, index) => (
                <Input
                  className="atlas-mono-textarea"
                  value={row.value}
                  onChange={(e) => {
                    const next = flatRows.slice();
                    next[index] = { ...next[index], value: e.target.value };
                    setFlatRows(next);
                  }}
                />
              ),
            },
            {
              title: '说明',
              width: 220,
              render: (_, row, index) => (
                <Input
                  value={row.description}
                  onChange={(e) => {
                    const next = flatRows.slice();
                    next[index] = { ...next[index], description: e.target.value };
                    setFlatRows(next);
                  }}
                />
              ),
            },
          ]}
        />
      )}

      <Modal
        title={`导入为${kind === 'calibration' ? '校准' : '设备'}配置档`}
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={() => void confirmImport()}
        okText="导入"
        destroyOnClose
      >
        <Form layout="vertical">
          <Form.Item label="名称" required>
            <Input value={importName} onChange={(e) => setImportName(e.target.value)} />
          </Form.Item>
          <Form.Item label="来源文件">
            <Typography.Text type="secondary">{importFilename || '—'}</Typography.Text>
          </Form.Item>
          <Form.Item label="预览">
            <Typography.Text type="secondary">
              共 {importPreviewRows.length} 个扁平键；导入后可按需启用。
            </Typography.Text>
          </Form.Item>
          <Form.Item label="导入后启用">
            <Switch checked={importActivate} onChange={setImportActivate} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={viewProfile ? `配置档 · ${viewProfile.name}` : '配置档'}
        open={viewOpen}
        onCancel={() => setViewOpen(false)}
        footer={<Button onClick={() => setViewOpen(false)}>关闭</Button>}
        width={720}
        destroyOnClose
      >
        <pre className="atlas-json" style={{ maxHeight: 480 }}>
          {JSON.stringify(viewProfile?.setting ?? {}, null, 2)}
        </pre>
      </Modal>
    </CollapsibleCard>
  );
}

export function SettingsPage() {
  const { message } = App.useApp();
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

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [settings, channelsResp, unitsResp, deviceList, calibrationList] = await Promise.all([
        agentApi.getSettings(),
        agentApi.getChannels(),
        agentApi.getUnits().catch(() => ({ units: [] })),
        agentApi.listDeviceProfiles().catch(() => []),
        agentApi.listCalibrationProfiles().catch(() => []),
      ]);
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
    } catch (error) {
      message.error(`加载配置失败: ${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void agentApi
      .status()
      .then((status) => {
        setAgentHostname(status.hostname || '');
        setCenterUrl(status.center_url || '');
      })
      .catch(() => {});
  }, []);

  const centerConfigsUrl = useMemo(() => centerConfigsPageUrl(centerUrl), [centerUrl]);

  const configSnapshotSummary = useMemo(() => {
    const enabledChannels = channels.filter((ch) => ch.enabled).length;
    return `变量 ${variables.length} · 设备档 ${deviceProfiles.length} · 校准档 ${calibrationProfiles.length} · 通道 ${channels.length}（启用 ${enabledChannels}）· 单位 ${units.length}`;
  }, [variables.length, deviceProfiles.length, calibrationProfiles.length, channels, units.length]);

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
      message.success(
        centerConfigsUrl ? (
          <span>
            已保存为中心配置模板 ·{' '}
            <a href={centerConfigsUrl} target="_blank" rel="noreferrer">
              在中心查看
            </a>
          </span>
        ) : (
          '已保存为中心配置模板'
        ),
      );
      setSaveModalOpen(false);
      await load();
    } catch (error) {
      message.error(`保存模板失败: ${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const loadConfigTemplate = (template: ConfigTemplateRow) => {
    Modal.confirm({
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
          <Button onClick={() => void load()} loading={busy}>
            重新加载
          </Button>
        }
      />

      <CollapsibleCard
        title="中心配置模板"
        defaultOpen
        extra={
          <Space wrap>
            {centerConfigsUrl ? (
              <Button type="link" href={centerConfigsUrl} target="_blank" rel="noreferrer">
                在中心管理
              </Button>
            ) : null}
            <Button type="primary" disabled={busy} onClick={openSaveModal}>
              保存为模板
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          「保存为模板」从当前机台配置拍快照；「加载」会覆盖本机变量、设备档、校准档与通道（Hostname / IP 保留本机值）。
          {centerConfigsUrl ? (
            <>
              {' '}
              也可在
              <Typography.Link href={centerConfigsUrl} target="_blank" rel="noreferrer">
                中心机台配置
              </Typography.Link>
              页面查看与管理全部模板。
            </>
          ) : null}
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
              onChange={setArrayExpandMode}
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
                    onClick={() => setVariables((prev) => prev.filter((_, i) => i !== index))}
                  >
                    删除
                  </Button>
                ),
            },
          ]}
        />
      </CollapsibleCard>

      <ProfileSection
        kind="device"
        title="设备配置档"
        profiles={deviceProfiles}
        busy={busy}
        onRefresh={load}
      />

      <ProfileSection
        kind="calibration"
        title="校准配置档"
        profiles={calibrationProfiles}
        busy={busy}
        onRefresh={load}
      />

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
                  onClick={() => setChannels((prev) => prev.filter((_, i) => i !== index))}
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
