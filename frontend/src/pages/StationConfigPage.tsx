import {
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Input,
  InputNumber,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { schedulerApi } from '../api/schedulerApi';
import type { AgentConfigProfile, AgentConfigSummary } from '../api/types';
import { HelpLabel, HelpTip } from '../components/HelpTip';
import { PageHeader } from '../components/PageHeader';
import {
  prepareSettingFromRows,
  settingRowKey,
  settingToEditableRows,
  textToSettingJson,
  type EditableSettingRow,
} from '../lib/deviceCfgIni';
import { DEFAULT_TABLE_PAGINATION } from '../utils/tableHelpers';
import { CONFIG_HELP } from './configHelp';
import {
  isSystemVarName,
  normalizeArrayExpandMode,
  normalizeChannels,
  normalizeVariables,
  prepareChannelsForSave,
  prepareVariablesForSave,
  rowKey,
  type EditableChannel,
  type EditableVariable,
} from './configEditor';
import { runOrConfirmUnsaved } from './leaveConfirm';

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

type ConfigTab = 'device' | 'calibration' | 'variables' | 'channels';

function CellInput(props: ComponentProps<typeof Input>) {
  return <Input variant="borderless" size="small" {...props} />;
}

function parseTab(value: string | null): ConfigTab {
  if (value === 'calibration' || value === 'variables' || value === 'channels') {
    return value;
  }
  return 'device';
}

function ProfileImportBar({
  agentId,
  kind,
  onDone,
}: {
  agentId: string;
  kind: 'device' | 'calibration';
  onDone: () => Promise<void>;
}) {
  const { message } = AntApp.useApp();
  const create =
    kind === 'device' ? schedulerApi.createDeviceProfile : schedulerApi.createCalibrationProfile;
  const label = kind === 'device' ? '设备' : '校验';
  return (
    <Space size={4} align="center">
      <Upload
        accept=".ini,.toml,text/plain"
        showUploadList={false}
        beforeUpload={(file) => {
          const reader = new FileReader();
          reader.onload = () => {
            void (async () => {
              const text = String(reader.result || '');
              const parsed = textToSettingJson(text, file.name);
              const name = file.name.replace(/\.[^.]+$/, '') || label;
              try {
                await create(agentId, {
                  name,
                  setting: parsed.setting,
                  source_filename: file.name,
                  activate: true,
                });
                message.success(`已导入并启用${label}配置档 ${name}`);
                await onDone();
              } catch (error) {
                message.error(`导入失败: ${error instanceof Error ? error.message : String(error)}`);
              }
            })();
          };
          reader.readAsText(file);
          return false;
        }}
      >
        <Button>导入 INI</Button>
      </Upload>
      <HelpTip text={CONFIG_HELP.iniImport} />
    </Space>
  );
}

export function StationConfigPage() {
  const { agentId = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { message, modal } = AntApp.useApp();
  const tab = parseTab(searchParams.get('tab'));
  const profileParam = searchParams.get('profile');

  const [detail, setDetail] = useState<AgentConfigSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [deviceProfiles, setDeviceProfiles] = useState<AgentConfigProfile[]>([]);
  const [calibrationProfiles, setCalibrationProfiles] = useState<AgentConfigProfile[]>([]);
  const [variables, setVariables] = useState<EditableVariable[]>([]);
  const [channels, setChannels] = useState<EditableChannel[]>([]);
  const [arrayExpandMode, setArrayExpandMode] = useState<'semicolon' | 'json'>('semicolon');
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingChannels, setSavingChannels] = useState(false);
  const [editingProfile, setEditingProfile] = useState<AgentConfigProfile | null>(null);
  const [profileName, setProfileName] = useState('');
  const [profileRows, setProfileRows] = useState<EditableSettingRow[]>([]);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileReady, setProfileReady] = useState(false);

  const savedVarsRef = useRef('');
  const savedChannelsRef = useRef('');
  const savedProfileRef = useRef('');

  const profileKind: 'device' | 'calibration' =
    tab === 'calibration' ? 'calibration' : 'device';
  const profileEditing = (tab === 'device' || tab === 'calibration') && Boolean(profileParam);

  const varsDirty =
    savedVarsRef.current !== '' &&
    JSON.stringify({ variables, arrayExpandMode }) !== savedVarsRef.current;
  const channelsDirty =
    savedChannelsRef.current !== '' && JSON.stringify(channels) !== savedChannelsRef.current;
  const profileDirty =
    profileEditing &&
    savedProfileRef.current !== '' &&
    JSON.stringify({ name: profileName, rows: profileRows }) !== savedProfileRef.current;
  const dirty =
    (tab === 'variables' && varsDirty) ||
    (tab === 'channels' && channelsDirty) ||
    profileDirty;

  const markVarsSaved = (nextVariables: EditableVariable[], mode: 'semicolon' | 'json') => {
    savedVarsRef.current = JSON.stringify({ variables: nextVariables, arrayExpandMode: mode });
  };
  const markChannelsSaved = (nextChannels: EditableChannel[]) => {
    savedChannelsRef.current = JSON.stringify(nextChannels);
  };
  const markProfileSaved = (name: string, rows: EditableSettingRow[]) => {
    savedProfileRef.current = JSON.stringify({ name, rows });
  };

  const reloadProfiles = async (id: string) => {
    const [devices, cals] = await Promise.all([
      schedulerApi.listDeviceProfiles(id),
      schedulerApi.listCalibrationProfiles(id),
    ]);
    setDeviceProfiles(devices);
    setCalibrationProfiles(cals);
    return { devices, cals };
  };

  const load = useCallback(async () => {
    if (!agentId) {
      navigate('/configs', { replace: true });
      return;
    }
    setLoading(true);
    try {
      const [summaries, settings, channelItems] = await Promise.all([
        schedulerApi.listAgentConfigSummaries(),
        schedulerApi.getAgentSettings(agentId),
        schedulerApi.getAgentChannels(agentId),
      ]);
      const row = summaries.find((item) => item.agent_id === agentId);
      if (!row) {
        message.error('未找到该机台配置');
        navigate('/configs', { replace: true });
        return;
      }
      const settingsRecord = asRecord(settings);
      const nextVariables = normalizeVariables(settings);
      const nextMode = normalizeArrayExpandMode(settingsRecord.array_expand_mode);
      const nextChannels = normalizeChannels(channelItems);
      setDetail(row);
      setVariables(nextVariables);
      setArrayExpandMode(nextMode);
      setChannels(nextChannels);
      markVarsSaved(nextVariables, nextMode);
      markChannelsSaved(nextChannels);
      const { devices, cals } = await reloadProfiles(agentId);
      const activeDevice = devices.find((profile) => profile.is_active);
      const activeCal = cals.find((profile) => profile.is_active);
      setDetail({
        ...row,
        active_device_name: row.active_device_name ?? activeDevice?.name ?? row.active_device_name,
        active_calibration_name:
          row.active_calibration_name ?? activeCal?.name ?? row.active_calibration_name,
      });
    } catch (error) {
      message.error(`加载详情失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [agentId, message, navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (!profileEditing) {
      setEditingProfile(null);
      setProfileName('');
      setProfileRows([]);
      setProfileReady(false);
      savedProfileRef.current = '';
      return;
    }
    const kindLabel = profileKind === 'device' ? '设备档' : '校验档';
    if (profileParam === 'new') {
      const rows = [{ _key: settingRowKey(), section: '', key: '', value: '' }];
      setEditingProfile(null);
      setProfileName(kindLabel);
      setProfileRows(rows);
      markProfileSaved(kindLabel, rows);
      setProfileReady(true);
      return;
    }
    const list = profileKind === 'device' ? deviceProfiles : calibrationProfiles;
    const profile = list.find((item) => item.id === profileParam) ?? null;
    if (!profile) {
      if (!loading && detail) {
        setSearchParams(tab === 'device' ? {} : { tab }, { replace: true });
      } else {
        setProfileReady(false);
      }
      return;
    }
    const rows = settingToEditableRows(profile.setting);
    const nextRows =
      rows.length > 0 ? rows : [{ _key: settingRowKey(), section: '', key: '', value: '' }];
    setEditingProfile(profile);
    setProfileName(profile.name || kindLabel);
    setProfileRows(nextRows);
    markProfileSaved(profile.name || kindLabel, nextRows);
    setProfileReady(true);
  }, [
    calibrationProfiles,
    detail,
    deviceProfiles,
    loading,
    profileEditing,
    profileKind,
    profileParam,
    setSearchParams,
    tab,
  ]);

  const setTab = (next: ConfigTab) => {
    runOrConfirmUnsaved(modal.confirm, dirty, () => {
      setSearchParams(next === 'device' ? {} : { tab: next });
    });
  };

  const openProfileEditor = (kind: 'device' | 'calibration', profile: AgentConfigProfile | null) => {
    runOrConfirmUnsaved(modal.confirm, dirty, () => {
      const params: Record<string, string> = { profile: profile?.id || 'new' };
      if (kind === 'calibration') params.tab = 'calibration';
      setSearchParams(params);
    });
  };

  const closeProfileEditor = () => {
    runOrConfirmUnsaved(modal.confirm, profileDirty, () => {
      setSearchParams(tab === 'device' ? {} : { tab });
    });
  };

  const goBack = () => {
    runOrConfirmUnsaved(modal.confirm, dirty, () => navigate('/configs'));
  };

  const activateProfile = async (kind: 'device' | 'calibration', profileId: string) => {
    try {
      if (kind === 'device') {
        await schedulerApi.activateDeviceProfile(agentId, profileId);
      } else {
        await schedulerApi.activateCalibrationProfile(agentId, profileId);
      }
      message.success(kind === 'device' ? '已启用设备配置档' : '已启用校验配置档');
      await load();
    } catch (error) {
      message.error(`启用失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const deleteProfile = (kind: 'device' | 'calibration', profile: AgentConfigProfile) => {
    const kindLabel = kind === 'device' ? '设备' : '校验';
    modal.confirm({
      title: '确认删除',
      content: profile.is_active
        ? `「${profile.name}」当前启用中，删除后该机将没有当前${kindLabel}档。确定删除？`
        : `确定删除${kindLabel}配置档「${profile.name}」？`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      async onOk() {
        try {
          if (kind === 'device') {
            await schedulerApi.deleteDeviceProfile(agentId, profile.id);
          } else {
            await schedulerApi.deleteCalibrationProfile(agentId, profile.id);
          }
          message.success(`${kindLabel}配置档已删除`);
          await load();
        } catch (error) {
          message.error(`删除失败：${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      },
    });
  };

  const saveProfile = async () => {
    const name = profileName.trim();
    if (!name) {
      message.error('配置档名称不能为空');
      return;
    }
    if (name.length > 128) {
      message.error('配置档名称过长');
      return;
    }
    const prepared = prepareSettingFromRows(profileRows);
    if (!prepared.ok) {
      message.error(prepared.error);
      return;
    }
    const kindLabel = profileKind === 'device' ? '设备' : '校验';
    setSavingProfile(true);
    try {
      if (editingProfile) {
        const body = {
          name,
          setting: prepared.setting,
          source_filename: editingProfile.source_filename || '',
        };
        if (profileKind === 'device') {
          await schedulerApi.updateDeviceProfile(agentId, editingProfile.id, body);
        } else {
          await schedulerApi.updateCalibrationProfile(agentId, editingProfile.id, body);
        }
        message.success(`${kindLabel}配置档已保存`);
      } else {
        const body = {
          name,
          setting: prepared.setting,
          source_filename: '',
          activate: false,
        };
        if (profileKind === 'device') {
          await schedulerApi.createDeviceProfile(agentId, body);
        } else {
          await schedulerApi.createCalibrationProfile(agentId, body);
        }
        message.success(`已新建${kindLabel}配置档`);
      }
      savedProfileRef.current = '';
      setSearchParams(tab === 'device' ? {} : { tab });
      await load();
    } catch (error) {
      message.error(`保存配置档失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSavingProfile(false);
    }
  };

  const saveSettings = async () => {
    const prepared = prepareVariablesForSave(variables);
    if (!prepared.ok) {
      message.error(prepared.error);
      return;
    }
    setSavingSettings(true);
    try {
      await schedulerApi.putAgentSettings(agentId, {
        variables: prepared.variables,
        array_expand_mode: arrayExpandMode,
      });
      message.success('变量已保存');
      markVarsSaved(variables, arrayExpandMode);
      await load();
    } catch (error) {
      message.error(`保存变量失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSavingSettings(false);
    }
  };

  const saveChannels = async () => {
    const prepared = prepareChannelsForSave(channels);
    if (!prepared.ok) {
      message.error(prepared.error);
      return;
    }
    setSavingChannels(true);
    try {
      await schedulerApi.putAgentChannels(agentId, { channels: prepared.channels });
      message.success('通道已保存');
      markChannelsSaved(channels);
      await load();
    } catch (error) {
      message.error(`保存通道失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSavingChannels(false);
    }
  };

  const profileColumns = (kind: 'device' | 'calibration') => [
    { title: '名称', dataIndex: 'name' as const },
    {
      title: '状态',
      dataIndex: 'is_active' as const,
      width: 80,
      render: (value: boolean) =>
        value ? <Tag color="success">启用中</Tag> : <Tag>未启用</Tag>,
    },
    { title: '来源文件', dataIndex: 'source_filename' as const },
    {
      title: '操作',
      width: 180,
      fixed: 'right' as const,
      render: (_: unknown, row: AgentConfigProfile) => (
        <Space>
          <Button size="small" type="link" onClick={() => openProfileEditor(kind, row)}>
            编辑
          </Button>
          <Button
            size="small"
            type="link"
            disabled={row.is_active}
            onClick={() => void activateProfile(kind, row.id)}
          >
            启用
          </Button>
          <Button size="small" type="link" danger onClick={() => deleteProfile(kind, row)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const profileEditor = (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }} wrap>
        <Space>
          <Button onClick={closeProfileEditor}>返回列表</Button>
          <Input
            placeholder="配置档名称"
            maxLength={128}
            value={profileName}
            onChange={(event) => setProfileName(event.target.value)}
            style={{ width: 240 }}
          />
        </Space>
        <Space>
          <Button
            onClick={() =>
              setProfileRows((current) => [
                ...current,
                { _key: settingRowKey(), section: '', key: '', value: '' },
              ])
            }
          >
            新建
          </Button>
          <Button type="primary" loading={savingProfile} onClick={() => void saveProfile()}>
            保存
          </Button>
        </Space>
      </Space>
      <Typography.Text type="secondary">值里的数组用分号分隔，例如 1;2</Typography.Text>
      <Table
        pagination={DEFAULT_TABLE_PAGINATION}
        rowKey={(row) => row._key}
        dataSource={profileRows}
        locale={{ emptyText: '暂无配置项，可新建或导入 INI' }}
        scroll={{ x: true }}
        columns={[
          {
            title: <HelpLabel label="段" text={CONFIG_HELP.profileSection} />,
            dataIndex: 'section',
            render: (value: string, row) => (
              <CellInput
                value={value}
                onChange={(event) =>
                  setProfileRows((current) =>
                    current.map((item) =>
                      item._key === row._key ? { ...item, section: event.target.value } : item,
                    ),
                  )
                }
              />
            ),
          },
          {
            title: <HelpLabel label="键" text={CONFIG_HELP.profileKey} />,
            dataIndex: 'key',
            render: (value: string, row) => (
              <CellInput
                value={value}
                onChange={(event) =>
                  setProfileRows((current) =>
                    current.map((item) =>
                      item._key === row._key ? { ...item, key: event.target.value } : item,
                    ),
                  )
                }
              />
            ),
          },
          {
            title: <HelpLabel label="值" text={CONFIG_HELP.profileValue} />,
            dataIndex: 'value',
            render: (value: string, row) => (
              <CellInput
                value={value}
                onChange={(event) =>
                  setProfileRows((current) =>
                    current.map((item) =>
                      item._key === row._key ? { ...item, value: event.target.value } : item,
                    ),
                  )
                }
              />
            ),
          },
          {
            title: '操作',
            width: 80,
            fixed: 'right',
            render: (_, row) => (
              <Button
                danger
                size="small"
                onClick={() =>
                  setProfileRows((current) => current.filter((item) => item._key !== row._key))
                }
              >
                删除
              </Button>
            ),
          },
        ]}
      />
    </Space>
  );

  const profileList = (kind: 'device' | 'calibration') => (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space align="center" style={{ justifyContent: 'flex-end', width: '100%' }} wrap>
        <Button onClick={() => openProfileEditor(kind, null)}>新建</Button>
        <ProfileImportBar agentId={agentId} kind={kind} onDone={load} />
      </Space>
      <Table
        pagination={DEFAULT_TABLE_PAGINATION}
        rowKey={(row) => row.id}
        dataSource={kind === 'device' ? deviceProfiles : calibrationProfiles}
        locale={{ emptyText: kind === 'device' ? '暂无设备配置档' : '暂无校验配置档' }}
        scroll={{ x: true }}
        columns={profileColumns(kind)}
      />
    </Space>
  );

  const tabItems = [
      {
        key: 'device',
        label: <HelpLabel label="设备配置档" text={CONFIG_HELP.deviceProfile} />,
        children:
          tab === 'device' && profileEditing
            ? profileReady
              ? profileEditor
              : <Spin />
            : profileList('device'),
      },
      {
        key: 'calibration',
        label: <HelpLabel label="校验配置档" text={CONFIG_HELP.calibrationProfile} />,
        children:
          tab === 'calibration' && profileEditing
            ? profileReady
              ? profileEditor
              : <Spin />
            : profileList('calibration'),
      },
      {
        key: 'variables',
        label: <HelpLabel label="变量" text={CONFIG_HELP.variables} />,
        children: (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Space align="center" style={{ justifyContent: 'flex-end', width: '100%' }} wrap>
              <HelpTip text={CONFIG_HELP.arrayExpand} />
              <Select
                value={arrayExpandMode}
                style={{ width: 160 }}
                onChange={setArrayExpandMode}
                options={[
                  { value: 'semicolon', label: '数组：分号' },
                  { value: 'json', label: '数组：JSON' },
                ]}
              />
              <Button
                onClick={() =>
                  setVariables((current) => [
                    ...current,
                    { _key: rowKey('var'), name: '', value: '', description: '' },
                  ])
                }
              >
                新建
              </Button>
              <Button type="primary" loading={savingSettings} onClick={() => void saveSettings()}>
                保存
              </Button>
            </Space>
            <Table
              pagination={DEFAULT_TABLE_PAGINATION}
              rowKey={(row) => row._key}
              dataSource={variables}
              locale={{ emptyText: '暂无变量，可新建' }}
              scroll={{ x: true }}
              columns={[
                {
                  title: '名称',
                  dataIndex: 'name',
                  render: (value: string, row) => (
                    <CellInput
                      maxLength={64}
                      disabled={isSystemVarName(row.name)}
                      value={value}
                      onChange={(event) =>
                        setVariables((current) =>
                          current.map((item) =>
                            item._key === row._key ? { ...item, name: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  ),
                },
                {
                  title: '值',
                  dataIndex: 'value',
                  render: (value: string, row) => (
                    <CellInput
                      disabled={isSystemVarName(row.name)}
                      value={value}
                      onChange={(event) =>
                        setVariables((current) =>
                          current.map((item) =>
                            item._key === row._key ? { ...item, value: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  ),
                },
                {
                  title: '说明',
                  dataIndex: 'description',
                  render: (value: string, row) => (
                    <CellInput
                      maxLength={200}
                      value={value}
                      onChange={(event) =>
                        setVariables((current) =>
                          current.map((item) =>
                            item._key === row._key
                              ? { ...item, description: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                  ),
                },
                {
                  title: '操作',
                  width: 80,
                  fixed: 'right',
                  render: (_, row) => (
                    <Button
                      danger
                      size="small"
                      disabled={isSystemVarName(row.name)}
                      onClick={() =>
                        setVariables((current) => current.filter((item) => item._key !== row._key))
                      }
                    >
                      删除
                    </Button>
                  ),
                },
              ]}
            />
          </Space>
        ),
      },
      {
        key: 'channels',
        label: <HelpLabel label="通道" text={CONFIG_HELP.channels} />,
        children: (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Space align="center" style={{ justifyContent: 'flex-end', width: '100%' }} wrap>
              <Button
                onClick={() =>
                  setChannels((current) => {
                    const nextIndex =
                      current.reduce((max, item) => Math.max(max, item.channel_index), -1) + 1;
                    return [
                      ...current,
                      {
                        _key: rowKey('ch'),
                        channel_index: nextIndex,
                        name: `CH${nextIndex}`,
                        enabled: true,
                        overlayText: '{}',
                      },
                    ];
                  })
                }
              >
                新建
              </Button>
              <Button type="primary" loading={savingChannels} onClick={() => void saveChannels()}>
                保存
              </Button>
            </Space>
            <Table
              pagination={DEFAULT_TABLE_PAGINATION}
              rowKey={(row) => row._key}
              dataSource={channels}
              locale={{ emptyText: '暂无通道，可新建' }}
              scroll={{ x: true }}
              columns={[
                {
                  title: '#',
                  dataIndex: 'channel_index',
                  width: 88,
                  render: (value: number, row) => (
                    <InputNumber
                      variant="borderless"
                      size="small"
                      min={0}
                      value={value}
                      onChange={(next) =>
                        setChannels((current) =>
                          current.map((item) =>
                            item._key === row._key
                              ? { ...item, channel_index: Number(next ?? 0) }
                              : item,
                          ),
                        )
                      }
                    />
                  ),
                },
                {
                  title: '名称',
                  dataIndex: 'name',
                  render: (value: string, row) => (
                    <CellInput
                      value={value}
                      onChange={(event) =>
                        setChannels((current) =>
                          current.map((item) =>
                            item._key === row._key ? { ...item, name: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  ),
                },
                {
                  title: '启用',
                  dataIndex: 'enabled',
                  width: 72,
                  render: (value: boolean, row) => (
                    <Checkbox
                      checked={value !== false}
                      onChange={(event) =>
                        setChannels((current) =>
                          current.map((item) =>
                            item._key === row._key
                              ? { ...item, enabled: event.target.checked }
                              : item,
                          ),
                        )
                      }
                    />
                  ),
                },
                {
                  title: <HelpLabel label="Overlay" text={CONFIG_HELP.overlay} />,
                  dataIndex: 'overlayText',
                  render: (value: string, row) => (
                    <Input.TextArea
                      variant="borderless"
                      size="small"
                      autoSize={{ minRows: 2, maxRows: 8 }}
                      value={value}
                      onChange={(event) =>
                        setChannels((current) =>
                          current.map((item) =>
                            item._key === row._key
                              ? { ...item, overlayText: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                  ),
                },
                {
                  title: '操作',
                  width: 80,
                  fixed: 'right',
                  render: (_, row) => (
                    <Button
                      danger
                      size="small"
                      onClick={() =>
                        setChannels((current) => current.filter((item) => item._key !== row._key))
                      }
                    >
                      删除
                    </Button>
                  ),
                },
              ]}
            />
          </Space>
        ),
      },
  ];

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <PageHeader
        title={detail ? `编辑配置 · ${detail.agent_name}` : '编辑配置'}
        onBack={goBack}
        extra={
          <Button onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        }
      />

      <Spin spinning={loading}>
        {detail ? (
          <Card>
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Descriptions size="small" column={2}>
                <Descriptions.Item label="机台 ID">{detail.agent_id}</Descriptions.Item>
                <Descriptions.Item label="IP">{detail.agent_ip}</Descriptions.Item>
                <Descriptions.Item label="当前设备档">
                  {detail.active_device_name || '—'}
                </Descriptions.Item>
                <Descriptions.Item label="当前校准档">
                  {detail.active_calibration_name || '—'}
                </Descriptions.Item>
              </Descriptions>
              <Tabs activeKey={tab} onChange={(key) => setTab(key as ConfigTab)} items={tabItems} />
            </Space>
          </Card>
        ) : null}
      </Spin>
    </Space>
  );
}
