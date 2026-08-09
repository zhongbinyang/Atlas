import {
  App,
  Button,
  Card,
  Checkbox,
  Drawer,
  Input,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { agentApi } from '../../api/agentApi';
import { ApiError } from '../../api/client';
import type { SpecTemplateDetail, SpecTemplateSummary, ViRunQueueStep } from '../../api/types';
import { CollapsibleCard } from '../../components/CollapsibleCard';
import {
  type ActiveSequenceBinding,
  bindActiveSequence,
  buildActiveSequenceSummary,
  clearActiveSequenceBinding,
  countRunQueueSteps,
  markActiveSequenceDirty,
  readActiveSequenceBinding,
} from './sequenceActive';
import {
  findGroupIndexForStep,
  formatStepSpecSummary,
  groupNameByQueueIndex,
  isFirstStepInGroup,
  listQueueStepRows,
  sectionMetricKeys,
} from './sequenceDetailModels';

type CatalogItem = {
  id?: number | string;
  name?: string;
  kind?: string;
  origin_agent_name?: string;
  inputs?: unknown;
  outputs?: unknown;
  source: 'labview' | 'general';
};

type QueueItem = ViRunQueueStep;

type VariableRow = {
  name: string;
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

const toId = (value: unknown): number | null => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
};

const normalizeQueueItem = (raw: unknown): QueueItem => {
  const item = asRecord(raw);
  const source = String(item.template_source || 'labview');
  return {
    id: item.id != null ? String(item.id) : undefined,
    template_source: source,
    vi_template_id: toId(item.vi_template_id),
    general_template_id: toId(item.general_template_id),
    name: String(item.name ?? item.title ?? ''),
    kind: item.kind != null ? String(item.kind) : undefined,
    inputs: item.inputs ?? [],
    outputs: item.outputs ?? [],
    enabled: item.enabled !== false,
    fail_policy: item.fail_policy === 'continue' ? 'continue' : 'stop',
    limits: item.limits ?? [],
    note: String(item.note ?? ''),
    resources: Array.isArray(item.resources) ? item.resources.map(String) : [],
    collapsed: !!item.collapsed,
    position: item.position != null ? Number(item.position) : undefined,
    spec_template_id: toId(item.spec_template_id),
    spec_section: String(item.spec_section ?? ''),
    spec_metrics: normalizeStringArray(item.spec_metrics),
  };
};

const buildPutItems = (queue: QueueItem[]) =>
  queue.map((item) => {
    if (item.template_source === 'group') {
      return {
        template_source: 'group',
        name: item.name || '分组',
        enabled: item.enabled !== false,
        collapsed: !!item.collapsed,
        note: item.note || '',
        inputs: [],
        limits: [],
        breakpoint: false,
        fail_policy: 'stop',
        resources: [],
      };
    }
    const source = item.template_source === 'general' ? 'general' : 'labview';
    return {
      template_source: source,
      vi_template_id: source === 'general' ? null : item.vi_template_id,
      general_template_id: source === 'general' ? item.general_template_id : null,
      inputs: item.inputs != null && typeof item.inputs === 'object' ? item.inputs : [],
      enabled: item.enabled !== false,
      breakpoint: false,
      fail_policy: item.fail_policy === 'continue' ? 'continue' : 'stop',
      limits: item.limits ?? [],
      note: item.note || '',
      resources: Array.isArray(item.resources) ? item.resources : [],
      spec_template_id: item.spec_template_id ?? null,
      spec_section: item.spec_section || '',
      spec_metrics: normalizeStringArray(item.spec_metrics),
    };
  });

export function SequenceEditTab() {
  const { message } = App.useApp();
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [templates, setTemplates] = useState<SequenceTemplate[]>([]);
  const [specTemplates, setSpecTemplates] = useState<SpecTemplateSummary[]>([]);
  const [specTemplateDetails, setSpecTemplateDetails] = useState<Record<number, SpecTemplateDetail>>({});
  const [variables, setVariables] = useState<VariableRow[]>([]);
  const [binding, setBinding] = useState<ActiveSequenceBinding | null>(() => readActiveSequenceBinding());
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'labview' | 'general'>('all');
  const [selectedIndexes, setSelectedIndexes] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const [inputsDraft, setInputsDraft] = useState('[]');
  const [limitsDraft, setLimitsDraft] = useState('[]');
  const [noteDraft, setNoteDraft] = useState('');
  const [resourceDraft, setResourceDraft] = useState('');
  const [specTemplateDraft, setSpecTemplateDraft] = useState<number | null>(null);
  const [specSectionDraft, setSpecSectionDraft] = useState('');
  const [specMetricsDraft, setSpecMetricsDraft] = useState<string[]>([]);
  const [variableInsertDraft, setVariableInsertDraft] = useState<string | null>(null);

  const stepCount = useMemo(() => countRunQueueSteps(queue), [queue]);
  const summary = useMemo(() => buildActiveSequenceSummary(stepCount, binding), [stepCount, binding]);
  const groupNamesByIndex = useMemo(() => groupNameByQueueIndex(queue), [queue]);
  const stepRows = useMemo(() => listQueueStepRows(queue), [queue]);

  const resolveSectionMetricCount = useCallback(
    (item: QueueItem): number | null => {
      const templateId = item.spec_template_id;
      const section = String(item.spec_section ?? '').trim();
      if (templateId == null || !section || section.includes('${')) return null;
      const detail = specTemplateDetails[templateId];
      if (!detail?.spec?.sections) return null;
      return sectionMetricKeys(detail.spec.sections, section).length || null;
    },
    [specTemplateDetails],
  );

  const ensureSpecTemplateDetails = useCallback(async (templateIds: number[]) => {
    const unique = [...new Set(templateIds.filter((id) => Number.isFinite(id)))];
    if (!unique.length) return;
    const results = await Promise.all(
      unique.map(async (id) => {
        try {
          const detail = await agentApi.getSpecTemplate(id);
          return [id, detail] as const;
        } catch {
          return null;
        }
      }),
    );
    setSpecTemplateDetails((prev) => {
      const next = { ...prev };
      results.forEach((entry) => {
        if (!entry || next[entry[0]] != null) return;
        next[entry[0]] = entry[1];
      });
      return next;
    });
  }, []);

  const noteQueueDirty = () => {
    const next = markActiveSequenceDirty();
    setBinding(next ?? readActiveSequenceBinding());
  };

  const loadAll = useCallback(async () => {
    setBusy(true);
    try {
      const [vi, general, queueResp, tpl, specTpl, settingsResp] = await Promise.all([
        agentApi.labviewAllTemplates(),
        agentApi.generalAllTemplates(),
        agentApi.getRunQueue(),
        agentApi.listSequenceTemplates(),
        agentApi.listSpecTemplates(),
        agentApi.getSettings(),
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
      const nextQueue = Array.isArray(queueData.items)
        ? queueData.items.map((item) => normalizeQueueItem(item))
        : [];
      setQueue(nextQueue);
      setTemplates(Array.isArray(tpl) ? (tpl as SequenceTemplate[]) : []);
      setSpecTemplates(Array.isArray(specTpl) ? specTpl : []);
      const settingsData = asRecord(settingsResp);
      setVariables(
        Array.isArray(settingsData.variables)
          ? settingsData.variables
              .map((item) => {
                const row = asRecord(item);
                const name = String(row.name ?? '').trim();
                return name ? { name } : null;
              })
              .filter((row): row is VariableRow => row != null)
          : [],
      );
      const templateIds = nextQueue
        .map((item) => item.spec_template_id)
        .filter((id): id is number => id != null);
      await ensureSpecTemplateDetails(templateIds);
      setBinding(readActiveSequenceBinding());
    } catch (error) {
      message.error(`加载序列编排数据失败: ${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }, [message, ensureSpecTemplateDetails]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const filteredCatalog = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.filter((item) => {
      if (sourceFilter !== 'all' && item.source !== sourceFilter) return false;
      if (!q) return true;
      return [item.name, item.id, item.origin_agent_name, item.kind, item.source]
        .map((v) => String(v ?? '').toLowerCase())
        .some((v) => v.includes(q));
    });
  }, [catalog, query, sourceFilter]);

  const persistQueue = async (next: QueueItem[], silent = false, markDirty = true) => {
    setBusy(true);
    try {
      const data = asRecord(await agentApi.putRunQueue({ items: buildPutItems(next) }));
      const items = Array.isArray(data.items)
        ? data.items.map((item) => normalizeQueueItem(item))
        : next;
      setQueue(items);
      if (!items.length) {
        clearActiveSequenceBinding();
        setBinding(null);
      } else if (markDirty) {
        noteQueueDirty();
      }
      if (!silent) message.success('队列已保存');
      return true;
    } catch (error) {
      message.error(`保存队列失败: ${getErrorMessage(error)}`);
      await loadAll();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addToQueue = async (item: CatalogItem) => {
    const next: QueueItem[] = [
      ...queue,
      {
        template_source: item.source,
        vi_template_id: item.source === 'labview' ? toId(item.id) : null,
        general_template_id: item.source === 'general' ? toId(item.id) : null,
        name: item.name,
        kind: item.kind,
        inputs: item.inputs ?? [],
        outputs: item.outputs ?? [],
        enabled: true,
        fail_policy: 'stop',
        limits: [],
        note: '',
        resources: [],
        spec_template_id: null,
        spec_section: '',
        spec_metrics: [],
      },
    ];
    await persistQueue(next);
  };

  const updateAt = async (index: number, patch: Partial<QueueItem>, silent = true) => {
    const next = queue.map((item, i) => (i === index ? { ...item, ...patch } : item));
    setQueue(next);
    await persistQueue(next, silent);
  };

  const move = async (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= queue.length) return;
    const next = queue.slice();
    const [row] = next.splice(index, 1);
    next.splice(target, 0, row);
    setSelectedIndexes([]);
    await persistQueue(next);
  };

  const removeAt = async (index: number) => {
    const next = queue.filter((_, i) => i !== index);
    setSelectedIndexes((prev) => prev.filter((i) => i !== index).map((i) => (i > index ? i - 1 : i)));
    await persistQueue(next);
  };

  const insertGroup = async () => {
    const name = window.prompt('分组名称', '分组')?.trim() || '分组';
    const next: QueueItem[] = [
      ...queue,
      {
        template_source: 'group',
        name,
        enabled: true,
        collapsed: false,
        note: '',
        inputs: [],
        limits: [],
        fail_policy: 'stop',
        resources: [],
      },
    ];
    await persistQueue(next);
  };

  const groupSelected = async () => {
    const indexes = selectedIndexes.slice().sort((a, b) => a - b);
    if (indexes.length < 1) {
      message.warning('请先勾选要编组的步骤');
      return;
    }
    if (indexes.some((i) => queue[i]?.template_source === 'group')) {
      message.warning('不能把分组再编进分组');
      return;
    }
    const name = window.prompt('编成一组的名称', '分组')?.trim() || '分组';
    const next = queue.slice();
    const first = indexes[0];
    for (let i = indexes.length - 1; i >= 0; i--) next.splice(indexes[i], 1);
    next.splice(first, 0, {
      template_source: 'group',
      name,
      enabled: true,
      collapsed: false,
      note: '',
      inputs: [],
      limits: [],
      fail_policy: 'stop',
      resources: [],
    });
    const selectedItems = indexes.map((i) => queue[i]);
    next.splice(first + 1, 0, ...selectedItems);
    setSelectedIndexes([]);
    await persistQueue(next);
  };

  const openDetail = (index: number) => {
    const item = queue[index];
    if (!item || item.template_source === 'group') return;
    setDetailIndex(index);
    setInputsDraft(JSON.stringify(item.inputs ?? [], null, 2));
    setLimitsDraft(JSON.stringify(item.limits ?? [], null, 2));
    setNoteDraft(item.note || '');
    setResourceDraft('');
    setSpecTemplateDraft(item.spec_template_id ?? null);
    setSpecSectionDraft(item.spec_section || '');
    setSpecMetricsDraft(Array.isArray(item.spec_metrics) ? item.spec_metrics.slice() : []);
    setVariableInsertDraft(null);
    if (item.spec_template_id != null) {
      void ensureSpecTemplateDetails([item.spec_template_id]);
    }
  };

  const saveDetail = async () => {
    if (detailIndex == null) return;
    let inputs: unknown = [];
    let limits: unknown = [];
    try {
      inputs = JSON.parse(inputsDraft || '[]');
    } catch {
      message.error('入参 JSON 无效');
      return;
    }
    try {
      limits = JSON.parse(limitsDraft || '[]');
    } catch {
      message.error('Spec/limits JSON 无效');
      return;
    }
    await updateAt(
      detailIndex,
      {
        inputs,
        limits,
        note: noteDraft,
        spec_template_id: specTemplateDraft,
        spec_section: specSectionDraft.trim(),
        spec_metrics: specMetricsDraft.slice(),
      },
      false,
    );
    setDetailIndex(null);
  };

  const addResource = async (index: number) => {
    const name = resourceDraft.trim();
    if (!name) return;
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)) {
      message.error('资源名非法（字母开头，可含数字._-）');
      return;
    }
    const item = queue[index];
    const resources = Array.isArray(item.resources) ? item.resources.slice() : [];
    if (resources.includes(name)) {
      message.warning('资源已存在');
      return;
    }
    resources.push(name);
    setResourceDraft('');
    await updateAt(index, { resources });
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
      const id = (data.id as string | number) ?? null;
      if (id != null) {
        setBinding(bindActiveSequence(id, String(data.name ?? name)));
      }
      message.success(`已保存序列模板: ${String(data.name ?? name)}`);
      await loadAll();
    } catch (error) {
      message.error(`保存模板失败: ${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const loadTemplate = async (id: string | number, name?: string) => {
    setBusy(true);
    try {
      await agentApi.loadSequenceTemplate(id);
      setBinding(bindActiveSequence(id, name || `模板 #${String(id)}`));
      message.success('已加载模板到本机执行顺序（已激活）');
      await loadAll();
    } catch (error) {
      message.error(`加载模板失败: ${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const unbindTemplate = () => {
    clearActiveSequenceBinding();
    setBinding(null);
    message.success('已解除模板绑定（执行顺序仍保留）');
  };

  const detailItem = detailIndex != null ? queue[detailIndex] : null;

  const detailSectionOptions = useMemo(() => {
    if (specTemplateDraft == null) return [];
    const detail = specTemplateDetails[specTemplateDraft];
    const sections = detail?.spec?.sections;
    if (!sections) return [];
    return Object.keys(sections)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ value: name, label: name }));
  }, [specTemplateDraft, specTemplateDetails]);

  const detailMetricOptions = useMemo(() => {
    if (specTemplateDraft == null) return [];
    const detail = specTemplateDetails[specTemplateDraft];
    const section = specSectionDraft.trim();
    if (!detail?.spec?.sections || !section || section.includes('${')) return [];
    return sectionMetricKeys(detail.spec.sections, section).map((key) => ({
      value: key,
      label: key,
    }));
  }, [specTemplateDraft, specSectionDraft, specTemplateDetails]);

  const insertVariableIntoSection = (variableName: string) => {
    const token = `\${${variableName}}`;
    setSpecSectionDraft((prev) => (prev ? `${prev}${token}` : token));
    setVariableInsertDraft(null);
  };

  return (
    <div className="atlas-page" style={{ gap: 12 }}>
      <div>
        <Space wrap size="middle">
          <Typography.Text strong>{summary.title}</Typography.Text>
          {summary.dirty ? <Tag color="warning">已改动</Tag> : null}
          {binding ? (
            <Button size="small" type="link" onClick={unbindTemplate}>
              解除绑定
            </Button>
          ) : null}
        </Space>
        <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 13 }}>
          运行页执行的是下方「执行顺序」，不是模板库里的其它项。点击「详情」可编辑入参 / Spec / 资源。
        </Typography.Paragraph>
      </div>

      <CollapsibleCard
        title="中心全部功能"
        extra={
          <Space wrap>
            <Select
              value={sourceFilter}
              style={{ width: 100 }}
              options={[
                { value: 'all', label: '全部' },
                { value: 'labview', label: 'VI' },
                { value: 'general', label: '通用' },
              ]}
              onChange={setSourceFilter}
            />
            <Input.Search
              allowClear
              placeholder="搜索"
              onSearch={setQuery}
              onChange={(e) => setQuery(e.target.value)}
              style={{ width: 160 }}
            />
          </Space>
        }
      >
        <Table
          size="small"
          loading={busy}
          rowKey={(row) => `${row.source}-${String(row.id)}`}
          dataSource={filteredCatalog}
          pagination={{ pageSize: 8, showSizeChanger: false }}
          locale={{ emptyText: '无匹配功能' }}
          columns={[
            { title: '名称', dataIndex: 'name', ellipsis: true },
            {
              title: '来源',
              width: 64,
              render: (_, row) => (
                <Tag color={row.source === 'labview' ? 'blue' : 'cyan'}>
                  {row.source === 'labview' ? 'VI' : '通用'}
                </Tag>
              ),
            },
            { title: '机台', dataIndex: 'origin_agent_name', ellipsis: true },
            {
              title: '操作',
              width: 72,
              render: (_, row) => (
                <Button size="small" type="link" onClick={() => void addToQueue(row)}>
                  加入
                </Button>
              ),
            },
          ]}
        />
      </CollapsibleCard>

      <Card
        title="执行顺序"
        extra={
          <Space wrap>
            <Button onClick={() => void insertGroup()} disabled={busy}>
              新建分组
            </Button>
            <Button onClick={() => void groupSelected()} disabled={busy || !selectedIndexes.length}>
              编成一组
            </Button>
            <Button onClick={() => void loadAll()} loading={busy}>
              刷新
            </Button>
            <Button type="primary" onClick={() => void saveTemplate()} loading={busy}>
              保存为模板
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          这是当前激活并可运行的序列。共用仪表填相同资源名（如 station.dca）；通道私有步骤留空即可并行。
        </Typography.Paragraph>
        <Table
          size="small"
          loading={busy}
          rowKey={(row) => String(row.queueIndex)}
          dataSource={stepRows}
          pagination={false}
          locale={{ emptyText: '队列为空：从上方功能库加入，或从下方模板加载' }}
          rowSelection={{
            selectedRowKeys: selectedIndexes.map(String),
            onChange: (keys) => setSelectedIndexes(keys.map((k) => Number(k))),
          }}
          columns={[
            {
              title: '#',
              width: 48,
              render: (_, __, index) => index + 1,
            },
            {
              title: '组名',
              width: 160,
              ellipsis: true,
              render: (_, row) => {
                const groupName = groupNamesByIndex[row.queueIndex] ?? '---';
                if (groupName === '---') {
                  return <Typography.Text type="secondary">---</Typography.Text>;
                }
                if (!isFirstStepInGroup(queue, row.queueIndex)) {
                  return groupName;
                }
                const markerIndex = findGroupIndexForStep(queue, row.queueIndex);
                if (markerIndex == null) return groupName;
                return (
                  <Input
                    size="small"
                    value={queue[markerIndex]?.name ?? groupName}
                    style={{ width: '100%' }}
                    onChange={(e) => {
                      const next = queue.slice();
                      next[markerIndex] = { ...next[markerIndex], name: e.target.value };
                      setQueue(next);
                    }}
                    onBlur={(e) => {
                      const next = queue.map((item, i) =>
                        i === markerIndex ? { ...item, name: e.target.value } : item,
                      );
                      void persistQueue(next, true);
                    }}
                  />
                );
              },
            },
            {
              title: '名称',
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <span>{row.item.name || '—'}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {row.item.template_source === 'general' ? '通用' : 'VI'}
                    {row.item.kind ? ` · ${row.item.kind}` : ''}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: '启用',
              width: 70,
              render: (_, row) => (
                <Switch
                  size="small"
                  checked={row.item.enabled !== false}
                  onChange={(checked) => void updateAt(row.queueIndex, { enabled: checked })}
                />
              ),
            },
            {
              title: 'Fail',
              width: 110,
              render: (_, row) => (
                <Select
                  size="small"
                  value={row.item.fail_policy === 'continue' ? 'continue' : 'stop'}
                  style={{ width: 96 }}
                  options={[
                    { value: 'stop', label: '停止' },
                    { value: 'continue', label: '继续' },
                  ]}
                  onChange={(value) => void updateAt(row.queueIndex, { fail_policy: value })}
                />
              ),
            },
            {
              title: '资源',
              width: 140,
              render: (_, row) => (
                <Space size={[4, 4]} wrap>
                  {(Array.isArray(row.item.resources) ? row.item.resources : []).map((name) => (
                    <Tag key={name}>{name}</Tag>
                  ))}
                </Space>
              ),
            },
            {
              title: 'Spec',
              width: 180,
              ellipsis: true,
              render: (_, row) => (
                <Typography.Text style={{ fontSize: 12 }}>
                  {formatStepSpecSummary(
                    row.item as Record<string, unknown>,
                    resolveSectionMetricCount(row.item),
                  )}
                </Typography.Text>
              ),
            },
            {
              title: '操作',
              width: 220,
              render: (_, row) => (
                <Space wrap>
                  <Button size="small" onClick={() => openDetail(row.queueIndex)}>
                    详情
                  </Button>
                  <Button size="small" onClick={() => void move(row.queueIndex, -1)}>
                    上移
                  </Button>
                  <Button size="small" onClick={() => void move(row.queueIndex, 1)}>
                    下移
                  </Button>
                  <Button size="small" danger onClick={() => void removeAt(row.queueIndex)}>
                    删除
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <CollapsibleCard title="中心序列模板">
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          「加载」会覆盖本机执行顺序并设为当前激活；「保存为模板」从当前执行顺序拍快照。
        </Typography.Paragraph>
        <Table
          size="small"
          loading={busy}
          rowKey={(row) => String(row.id)}
          dataSource={templates}
          pagination={{ pageSize: 6, showSizeChanger: false }}
          locale={{ emptyText: '暂无序列模板' }}
          columns={[
            { title: 'ID', dataIndex: 'id', width: 72 },
            {
              title: '名称',
              ellipsis: true,
              render: (_, row) => (
                <Space>
                  <span>{row.name}</span>
                  {binding && String(binding.id) === String(row.id) ? (
                    <Tag color="success">激活</Tag>
                  ) : null}
                </Space>
              ),
            },
            { title: '步骤', dataIndex: 'step_count', width: 72 },
            { title: '创建者', dataIndex: 'created_by_agent_name', ellipsis: true },
            {
              title: '操作',
              width: 80,
              render: (_, row) =>
                row.id != null ? (
                  <Button
                    size="small"
                    type="link"
                    onClick={() => void loadTemplate(row.id!, row.name)}
                  >
                    加载
                  </Button>
                ) : null,
            },
          ]}
        />
      </CollapsibleCard>

      <Drawer
        width={640}
        title={detailItem ? `步骤详情 · ${detailItem.name || ''}` : '步骤详情'}
        open={detailIndex != null}
        onClose={() => setDetailIndex(null)}
        extra={
          <Button type="primary" onClick={() => void saveDetail()} loading={busy}>
            保存
          </Button>
        }
      >
        {detailItem && detailIndex != null ? (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <div>
              <Typography.Text strong>资源锁</Typography.Text>
              <div style={{ marginTop: 8 }}>
                <Space wrap>
                  {(detailItem.resources || []).map((name) => (
                    <Tag
                      key={name}
                      closable
                      onClose={() => {
                        const resources = (detailItem.resources || []).filter((x) => x !== name);
                        void updateAt(detailIndex, { resources });
                      }}
                    >
                      {name}
                    </Tag>
                  ))}
                </Space>
              </div>
              <Space style={{ marginTop: 8 }}>
                <Input
                  placeholder="例如 station.dca"
                  value={resourceDraft}
                  onChange={(e) => setResourceDraft(e.target.value)}
                  onPressEnter={() => void addResource(detailIndex)}
                />
                <Button onClick={() => void addResource(detailIndex)}>添加</Button>
              </Space>
            </div>
            <div>
              <Typography.Text strong>备注</Typography.Text>
              <Input.TextArea
                rows={2}
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                style={{ marginTop: 8 }}
              />
            </div>
            <div>
              <Typography.Text strong>Spec 模板</Typography.Text>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="选择中心 Spec 模板（可选）"
                value={specTemplateDraft ?? undefined}
                style={{ width: '100%', marginTop: 8 }}
                options={specTemplates.map((tpl) => ({
                  value: tpl.id,
                  label: `#${tpl.id} ${tpl.name}${tpl.source_filename ? ` · ${tpl.source_filename}` : ''}`,
                }))}
                onChange={(value) => {
                  const nextId = value ?? null;
                  setSpecTemplateDraft(nextId);
                  setSpecMetricsDraft([]);
                  if (nextId != null) void ensureSpecTemplateDetails([nextId]);
                }}
              />
            </div>
            <div>
              <Typography.Text strong>Section</Typography.Text>
              <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 12 }}>
                完整 INI 段名，如 FMT_HT；也可使用变量，如 ${'${SpecSection}'}（站点变量默认
                SpecSection=FMT_HT，通道 overlay 可覆盖为 FMT_RT 等）。
              </Typography.Paragraph>
              <Space.Compact style={{ width: '100%', marginTop: 8 }}>
                <Input
                  placeholder="FMT_HT"
                  value={specSectionDraft}
                  onChange={(e) => {
                    setSpecSectionDraft(e.target.value);
                    setSpecMetricsDraft([]);
                  }}
                />
                <Select
                  allowClear
                  placeholder="插入变量"
                  value={variableInsertDraft ?? undefined}
                  style={{ width: 140 }}
                  options={variables.map((row) => ({
                    value: row.name,
                    label: row.name,
                  }))}
                  onChange={(value) => {
                    if (value) insertVariableIntoSection(String(value));
                  }}
                />
              </Space.Compact>
              {detailSectionOptions.length ? (
                <Select
                  allowClear
                  placeholder="从模板选择 Section"
                  style={{ width: '100%', marginTop: 8 }}
                  options={detailSectionOptions}
                  onChange={(value) => {
                    if (value) {
                      setSpecSectionDraft(String(value));
                      setSpecMetricsDraft([]);
                    }
                  }}
                />
              ) : null}
            </div>
            <div>
              <Typography.Text strong>指标</Typography.Text>
              <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 12 }}>
                留空表示使用该 Section 的全部指标。
              </Typography.Paragraph>
              <Select
                mode="multiple"
                allowClear
                placeholder={
                  specTemplateDraft == null
                    ? '请先选择 Spec 模板'
                    : detailMetricOptions.length
                      ? '选择指标（可选）'
                      : '输入 Section 后可选指标'
                }
                value={specMetricsDraft}
                style={{ width: '100%', marginTop: 8 }}
                options={detailMetricOptions}
                disabled={!specTemplateDraft || !detailMetricOptions.length}
                onChange={(value) => setSpecMetricsDraft(value.map(String))}
              />
            </div>
            <div>
              <Typography.Text strong>入参 JSON</Typography.Text>
              <Input.TextArea
                className="atlas-mono-textarea"
                rows={10}
                value={inputsDraft}
                onChange={(e) => setInputsDraft(e.target.value)}
                style={{ marginTop: 8 }}
              />
            </div>
            <div>
              <Typography.Text strong>Spec / limits JSON</Typography.Text>
              <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 12 }}>
                手填 limits 覆盖模板同名字段。
              </Typography.Paragraph>
              <Input.TextArea
                className="atlas-mono-textarea"
                rows={8}
                value={limitsDraft}
                onChange={(e) => setLimitsDraft(e.target.value)}
                style={{ marginTop: 8 }}
              />
            </div>
            <div>
              <Checkbox
                checked={detailItem.enabled !== false}
                onChange={(e) => void updateAt(detailIndex, { enabled: e.target.checked })}
              >
                启用此步骤
              </Checkbox>
              <Select
                style={{ width: 160, marginLeft: 12 }}
                value={detailItem.fail_policy === 'continue' ? 'continue' : 'stop'}
                options={[
                  { value: 'stop', label: '失败则停止' },
                  { value: 'continue', label: '失败则继续' },
                ]}
                onChange={(value) => void updateAt(detailIndex, { fail_policy: value })}
              />
            </div>
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}
