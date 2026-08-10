import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Drawer,
  Form,
  Input,
  Modal,
  Popover,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { EMPTY_PLACEHOLDER } from '@shared/uiCopy';
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
  applyGroupSpecToDescendants,
  effectiveSpecSectionForStep,
  findGroupIndexForStep,
  formatStepSpecSummary,
  groupNameByQueueIndex,
  isFirstStepInGroup,
  LIMIT_VALUE_COLUMN_DEFS,
  LIMIT_VALUE_COLUMNS_WIDTH,
  listQueueStepRows,
  resolveStepLimitPreview,
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

const validateGroupSpecBinding = (
  templateId: number | null,
  section: string,
  details: Record<number, SpecTemplateDetail>,
): string | null => {
  const trimmed = section.trim();
  if (templateId == null && !trimmed) return null;
  if (templateId != null && !trimmed) return '已选择 Spec 模板时须选择 Spec 段';
  if (templateId == null && trimmed) return '须先选择 Spec 模板';
  const detail = details[templateId!];
  if (!detail?.spec?.sections?.[trimmed]) return `Spec 段「${trimmed}」不在所选模板中`;
  return null;
};

const sectionOptionsForTemplate = (
  templateId: number | null,
  details: Record<number, SpecTemplateDetail>,
) => {
  if (templateId == null) return [];
  const sections = details[templateId]?.spec?.sections;
  if (!sections) return [];
  return Object.keys(sections)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ value: name, label: name }));
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
        spec_template_id: item.spec_template_id ?? null,
        spec_section: String(item.spec_section ?? '').trim(),
        spec_metrics: [],
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
  const { message, modal } = App.useApp();
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [templates, setTemplates] = useState<SequenceTemplate[]>([]);
  const [specTemplates, setSpecTemplates] = useState<SpecTemplateSummary[]>([]);
  const [specTemplateDetails, setSpecTemplateDetails] = useState<Record<number, SpecTemplateDetail>>({});
  const [binding, setBinding] = useState<ActiveSequenceBinding | null>(() => readActiveSequenceBinding());
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'labview' | 'general'>('all');
  const [selectedIndexes, setSelectedIndexes] = useState<number[]>([]);
  const [pageBusy, setPageBusy] = useState(false);
  const [queueSaving, setQueueSaving] = useState(false);
  const [savingRowIndexes, setSavingRowIndexes] = useState<number[]>([]);
  const [detailSaving, setDetailSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const [inputsDraft, setInputsDraft] = useState('[]');
  const [limitsDraft, setLimitsDraft] = useState('[]');
  const [noteDraft, setNoteDraft] = useState('');
  const [resourceDraft, setResourceDraft] = useState('');
  const [specTemplateDraft, setSpecTemplateDraft] = useState<number | null>(null);
  const [specSectionDraft, setSpecSectionDraft] = useState('');
  const [specMetricsDraft, setSpecMetricsDraft] = useState<string[]>([]);
  const [groupNameModal, setGroupNameModal] = useState<'insert' | 'group' | null>(null);
  const [groupNameInput, setGroupNameInput] = useState('分组');
  const [groupSpecTemplateDraft, setGroupSpecTemplateDraft] = useState<number | null>(null);
  const [groupSpecSectionDraft, setGroupSpecSectionDraft] = useState('');
  const [saveSeqTemplateOpen, setSaveSeqTemplateOpen] = useState(false);
  const [saveSeqTemplateName, setSaveSeqTemplateName] = useState('');
  const [saveSeqTemplateNote, setSaveSeqTemplateNote] = useState('');
  const [enabledDraft, setEnabledDraft] = useState(true);
  const [failPolicyDraft, setFailPolicyDraft] = useState<'stop' | 'continue'>('stop');
  const [resourcesDraft, setResourcesDraft] = useState<string[]>([]);

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
    setPageBusy(true);
    try {
      const [vi, general, queueResp, tpl, specTpl] = await Promise.all([
        agentApi.labviewAllTemplates(),
        agentApi.generalAllTemplates(),
        agentApi.getRunQueue(),
        agentApi.listSequenceTemplates(),
        agentApi.listSpecTemplates(),
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
      const templateIds = nextQueue
        .map((item) => item.spec_template_id)
        .filter((id): id is number => id != null);
      await ensureSpecTemplateDetails(templateIds);
      setBinding(readActiveSequenceBinding());
      setLoadError(null);
    } catch (error) {
      setLoadError(getErrorMessage(error));
    } finally {
      setPageBusy(false);
    }
  }, [ensureSpecTemplateDetails]);

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

  const persistQueue = async (
    next: QueueItem[],
    options?: {
      silent?: boolean;
      markDirty?: boolean;
      rowIndexes?: number[];
      showPageBusy?: boolean;
    },
  ) => {
    const { silent = true, markDirty = true, rowIndexes, showPageBusy = false } = options ?? {};
    if (showPageBusy) setPageBusy(true);
    else if (rowIndexes?.length) setSavingRowIndexes(rowIndexes);
    else setQueueSaving(true);
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
      if (showPageBusy) setPageBusy(false);
      if (rowIndexes?.length) setSavingRowIndexes([]);
      else setQueueSaving(false);
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
    await persistQueue(next, { showPageBusy: true });
  };

  const updateAt = async (index: number, patch: Partial<QueueItem>, silent = true) => {
    const next = queue.map((item, i) => (i === index ? { ...item, ...patch } : item));
    setQueue(next);
    await persistQueue(next, { silent, rowIndexes: [index] });
  };

  const move = async (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= queue.length) return;
    const next = queue.slice();
    const [row] = next.splice(index, 1);
    next.splice(target, 0, row);
    setSelectedIndexes([]);
    await persistQueue(next, { silent: true });
  };

  const removeAt = async (index: number) => {
    const next = queue.filter((_, i) => i !== index);
    setSelectedIndexes((prev) => prev.filter((i) => i !== index).map((i) => (i > index ? i - 1 : i)));
    await persistQueue(next, { silent: true });
  };

  const confirmRemoveAt = (index: number) => {
    const item = queue[index];
    const label = item?.name?.trim() || `步骤 ${index + 1}`;
    modal.confirm({
      title: '删除步骤',
      content: `确定删除「${label}」？`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => removeAt(index),
    });
  };

  const openInsertGroupModal = () => {
    setGroupNameInput('分组');
    setGroupSpecTemplateDraft(null);
    setGroupSpecSectionDraft('');
    setGroupNameModal('insert');
  };

  const openGroupSelectedModal = () => {
    const indexes = selectedIndexes.slice().sort((a, b) => a - b);
    if (indexes.length < 1) {
      message.warning('请先勾选要编组的步骤');
      return;
    }
    if (indexes.some((i) => queue[i]?.template_source === 'group')) {
      message.warning('不能把分组再编进分组');
      return;
    }
    setGroupNameInput('分组');
    setGroupSpecTemplateDraft(null);
    setGroupSpecSectionDraft('');
    setGroupNameModal('group');
  };

  const resetGroupModal = () => {
    setGroupNameModal(null);
    setGroupSpecTemplateDraft(null);
    setGroupSpecSectionDraft('');
  };

  const confirmGroupName = async () => {
    const name = groupNameInput.trim();
    if (!name) {
      message.warning('请输入分组名称');
      return;
    }
    const specErr = validateGroupSpecBinding(
      groupSpecTemplateDraft,
      groupSpecSectionDraft,
      specTemplateDetails,
    );
    if (specErr) {
      message.warning(specErr);
      return;
    }
    const groupItem: QueueItem = {
      template_source: 'group',
      name,
      enabled: true,
      collapsed: false,
      note: '',
      inputs: [],
      limits: [],
      fail_policy: 'stop',
      resources: [],
      spec_template_id: groupSpecTemplateDraft,
      spec_section: groupSpecSectionDraft.trim(),
      spec_metrics: [],
    };
    if (groupNameModal === 'insert') {
      const next: QueueItem[] = [...queue, groupItem];
      resetGroupModal();
      await persistQueue(next, { showPageBusy: true });
      return;
    }
    if (groupNameModal === 'group') {
      const indexes = selectedIndexes.slice().sort((a, b) => a - b);
      const next = queue.slice();
      const first = indexes[0];
      for (let i = indexes.length - 1; i >= 0; i--) next.splice(indexes[i], 1);
      next.splice(first, 0, groupItem);
      const selectedItems = indexes.map((i) => queue[i]);
      next.splice(first + 1, 0, ...selectedItems);
      const synced = applyGroupSpecToDescendants(next, first);
      setSelectedIndexes([]);
      resetGroupModal();
      await persistQueue(synced, { showPageBusy: true });
    }
  };

  const updateGroupSpecAt = async (
    markerIndex: number,
    patch: Partial<Pick<QueueItem, 'spec_template_id' | 'spec_section'>>,
  ) => {
    const current = queue[markerIndex];
    if (!current || current.template_source !== 'group') return;
    const merged: QueueItem = {
      ...current,
      spec_template_id:
        patch.spec_template_id !== undefined
          ? patch.spec_template_id
          : (current.spec_template_id ?? null),
      spec_section:
        patch.spec_section !== undefined
          ? patch.spec_section
          : String(current.spec_section ?? '').trim(),
    };
    if (patch.spec_template_id === null) {
      merged.spec_section = '';
    }
    const specErr = validateGroupSpecBinding(
      merged.spec_template_id ?? null,
      merged.spec_section || '',
      specTemplateDetails,
    );
    if (specErr) {
      message.warning(specErr);
      return;
    }
    let next = queue.slice();
    next[markerIndex] = merged;
    next = applyGroupSpecToDescendants(next, markerIndex);
    const affectedIndexes: number[] = [];
    for (let i = markerIndex; i < next.length; i++) {
      if (i > markerIndex && next[i]?.template_source === 'group') break;
      affectedIndexes.push(i);
    }
    setQueue(next);
    await persistQueue(next, { silent: true, rowIndexes: affectedIndexes });
  };

  const limitValueColumns = useMemo(
    () =>
      LIMIT_VALUE_COLUMN_DEFS.map(({ key, title, width }) => ({
        title,
        width,
        align: 'right' as const,
        ellipsis: true,
        render: (_: unknown, row: { item: QueueItem }) => {
          const cells = resolveStepLimitPreview(
            row.item as Record<string, unknown>,
            specTemplateDetails,
          );
          const text = cells[key] || EMPTY_PLACEHOLDER;
          return (
            <Typography.Text
              style={{ fontSize: 12, whiteSpace: 'nowrap' }}
              ellipsis={{ tooltip: text === EMPTY_PLACEHOLDER ? undefined : text }}
            >
              {text}
            </Typography.Text>
          );
        },
      })),
    [specTemplateDetails],
  );

  const renderGroupSpecCell = (markerIndex: number, section: string) => {
    const templateId = queue[markerIndex]?.spec_template_id ?? null;
    const options = sectionOptionsForTemplate(templateId, specTemplateDetails);
    return (
      <Popover
        trigger="click"
        placement="bottomLeft"
        title="分组 Spec"
        content={
          <Space direction="vertical" size={8} style={{ width: 260 }}>
            <Select
              allowClear
              size="small"
              showSearch
              optionFilterProp="label"
              placeholder="Spec 模板"
              style={{ width: '100%' }}
              value={templateId ?? undefined}
              options={specTemplates.map((tpl) => ({
                value: tpl.id,
                label: `#${tpl.id} ${tpl.name}`,
              }))}
              onChange={(value) => {
                void updateGroupSpecAt(markerIndex, {
                  spec_template_id: value ?? null,
                  spec_section: '',
                });
              }}
            />
            <Select
              allowClear
              size="small"
              showSearch
              optionFilterProp="label"
              placeholder="Spec 段"
              style={{ width: '100%' }}
              value={section || undefined}
              options={options}
              disabled={templateId == null || !options.length}
              onFocus={() => {
                if (templateId != null) void ensureSpecTemplateDetails([templateId]);
              }}
              onChange={(value) => {
                void updateGroupSpecAt(markerIndex, {
                  spec_section: value ? String(value) : '',
                });
              }}
            />
          </Space>
        }
      >
        <Button type="link" size="small" style={{ padding: 0, height: 'auto' }}>
          <Typography.Text ellipsis style={{ maxWidth: 80 }}>
            {section || '设置 Spec'}
          </Typography.Text>
        </Button>
      </Popover>
    );
  };

  const openSaveTemplateModal = () => {
    if (!queue.length) {
      message.error('当前队列为空，无法保存模板');
      return;
    }
    setSaveSeqTemplateName('');
    setSaveSeqTemplateNote('');
    setSaveSeqTemplateOpen(true);
  };

  const confirmSaveTemplate = async () => {
    const name = saveSeqTemplateName.trim();
    if (!name) {
      message.warning('请输入序列模板名称');
      return;
    }
    setPageBusy(true);
    try {
      const data = asRecord(
        await agentApi.saveSequenceTemplate({
          name,
          note: saveSeqTemplateNote.trim() || undefined,
        }),
      );
      const id = (data.id as string | number) ?? null;
      if (id != null) {
        setBinding(bindActiveSequence(id, String(data.name ?? name)));
      }
      message.success(`已保存序列模板: ${String(data.name ?? name)}`);
      setSaveSeqTemplateOpen(false);
      await loadAll();
    } catch (error) {
      message.error(`保存模板失败: ${getErrorMessage(error)}`);
    } finally {
      setPageBusy(false);
    }
  };

  const openDetail = (index: number) => {
    const item = queue[index];
    if (!item || item.template_source === 'group') return;
    setDetailIndex(index);
    setInputsDraft(JSON.stringify(item.inputs ?? [], null, 2));
    setLimitsDraft(JSON.stringify(item.limits ?? [], null, 2));
    setNoteDraft(item.note || '');
    setResourceDraft('');
    setEnabledDraft(item.enabled !== false);
    setFailPolicyDraft(item.fail_policy === 'continue' ? 'continue' : 'stop');
    setResourcesDraft(Array.isArray(item.resources) ? item.resources.slice() : []);
    setSpecTemplateDraft(item.spec_template_id ?? null);
    setSpecSectionDraft(item.spec_section || '');
    setSpecMetricsDraft(Array.isArray(item.spec_metrics) ? item.spec_metrics.slice() : []);
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
    setDetailSaving(true);
    try {
      const inheritedGroup =
        detailInheritedGroupIndex != null ? queue[detailInheritedGroupIndex] : null;
      const next = queue.map((item, i) =>
        i === detailIndex
          ? {
              ...item,
              inputs,
              limits,
              note: noteDraft,
              enabled: enabledDraft,
              fail_policy: failPolicyDraft,
              resources: resourcesDraft.slice(),
              spec_template_id: inheritedGroup
                ? (inheritedGroup.spec_template_id ?? null)
                : specTemplateDraft,
              spec_section: inheritedGroup
                ? String(inheritedGroup.spec_section ?? '').trim()
                : specSectionDraft.trim(),
              spec_metrics: inheritedGroup ? [] : specMetricsDraft.slice(),
            }
          : item,
      );
      setQueue(next);
      const ok = await persistQueue(next, { silent: true, rowIndexes: [detailIndex] });
      if (ok) setDetailIndex(null);
    } finally {
      setDetailSaving(false);
    }
  };

  const addResource = () => {
    const name = resourceDraft.trim();
    if (!name) return;
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)) {
      message.error('资源名非法（字母开头，可含数字._-）');
      return;
    }
    if (resourcesDraft.includes(name)) {
      message.warning('资源已存在');
      return;
    }
    setResourcesDraft((prev) => [...prev, name]);
    setResourceDraft('');
  };

  const loadTemplate = (id: string | number, name?: string) => {
    const label = name?.trim() || `模板 #${String(id)}`;
    modal.confirm({
      title: '加载中心序列模板',
      content: `将用模板「${label}」覆盖本机执行顺序并设为当前激活，是否继续？`,
      okText: '加载并覆盖',
      cancelText: '取消',
      onOk: async () => {
        setPageBusy(true);
        try {
          await agentApi.loadSequenceTemplate(id);
          setBinding(bindActiveSequence(id, name || `模板 #${String(id)}`));
          message.success('已加载模板到本机执行顺序（已激活）');
          await loadAll();
        } catch (error) {
          message.error(`加载模板失败: ${getErrorMessage(error)}`);
        } finally {
          setPageBusy(false);
        }
      },
    });
  };

  const unbindTemplate = () => {
    clearActiveSequenceBinding();
    setBinding(null);
    message.success('已解除模板绑定（执行顺序仍保留）');
  };

  const detailItem = detailIndex != null ? queue[detailIndex] : null;

  const isDetailDirty = useMemo(() => {
    if (detailIndex == null || !detailItem) return false;
    if (enabledDraft !== (detailItem.enabled !== false)) return true;
    if (failPolicyDraft !== (detailItem.fail_policy === 'continue' ? 'continue' : 'stop')) return true;
    const itemResources = Array.isArray(detailItem.resources) ? detailItem.resources : [];
    if (JSON.stringify(resourcesDraft) !== JSON.stringify(itemResources)) return true;
    if (noteDraft !== (detailItem.note || '')) return true;
    if (specTemplateDraft !== (detailItem.spec_template_id ?? null)) return true;
    if (specSectionDraft !== (detailItem.spec_section || '')) return true;
    if (
      JSON.stringify(specMetricsDraft) !==
      JSON.stringify(normalizeStringArray(detailItem.spec_metrics))
    ) {
      return true;
    }
    try {
      if (JSON.stringify(JSON.parse(inputsDraft || '[]')) !== JSON.stringify(detailItem.inputs ?? [])) {
        return true;
      }
    } catch {
      return true;
    }
    try {
      if (JSON.stringify(JSON.parse(limitsDraft || '[]')) !== JSON.stringify(detailItem.limits ?? [])) {
        return true;
      }
    } catch {
      return true;
    }
    return false;
  }, [
    detailIndex,
    detailItem,
    enabledDraft,
    failPolicyDraft,
    resourcesDraft,
    noteDraft,
    specTemplateDraft,
    specSectionDraft,
    specMetricsDraft,
    inputsDraft,
    limitsDraft,
  ]);

  const requestCloseDetail = () => {
    if (!isDetailDirty) {
      setDetailIndex(null);
      return;
    }
    modal.confirm({
      title: '放弃未保存的更改？',
      content: '关闭详情将丢弃未点击「保存」的编辑。',
      okText: '放弃',
      okType: 'danger',
      cancelText: '继续编辑',
      onOk: () => setDetailIndex(null),
    });
  };

  const detailSectionOptions = useMemo(() => {
    return sectionOptionsForTemplate(specTemplateDraft, specTemplateDetails);
  }, [specTemplateDraft, specTemplateDetails]);

  const groupModalSectionOptions = useMemo(() => {
    return sectionOptionsForTemplate(groupSpecTemplateDraft, specTemplateDetails);
  }, [groupSpecTemplateDraft, specTemplateDetails]);

  const detailInheritedGroupIndex =
    detailIndex != null ? findGroupIndexForStep(queue, detailIndex) : null;

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

      {loadError ? (
        <Alert
          type="error"
          showIcon
          message="加载序列编排数据失败"
          description={loadError}
          action={
            <Button size="small" onClick={() => void loadAll()}>
              重试
            </Button>
          }
        />
      ) : null}

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
          loading={pageBusy}
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
            <Button onClick={openInsertGroupModal} disabled={pageBusy || queueSaving}>
              新建分组
            </Button>
            <Button onClick={openGroupSelectedModal} disabled={pageBusy || queueSaving || !selectedIndexes.length}>
              编成一组
            </Button>
            <Button onClick={() => void loadAll()} loading={pageBusy}>
              刷新
            </Button>
            <Button type="primary" onClick={openSaveTemplateModal} loading={pageBusy}>
              保存为模板
            </Button>
            {queueSaving ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                保存中…
              </Typography.Text>
            ) : null}
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          这是当前激活并可运行的序列。共用仪表填相同资源名（如 station.dca）；通道私有步骤留空即可并行。
        </Typography.Paragraph>
        <Table
          size="small"
          loading={pageBusy}
          rowKey={(row) => String(row.queueIndex)}
          dataSource={stepRows}
          pagination={false}
          scroll={{ x: 1124 + LIMIT_VALUE_COLUMNS_WIDTH }}
          tableLayout="fixed"
          rowClassName={(row) => (savingRowIndexes.includes(row.queueIndex) ? 'atlas-row-saving' : '')}
          locale={{ emptyText: '队列为空：从上方功能库加入，或从下方模板加载' }}
          rowSelection={{
            selectedRowKeys: selectedIndexes.map(String),
            onChange: (keys) => setSelectedIndexes(keys.map((k) => Number(k))),
          }}
          columns={[
            {
              title: '#',
              width: 48,
              fixed: 'left',
              render: (_, __, index) => index + 1,
            },
            {
              title: '分组',
              width: 112,
              fixed: 'left',
              ellipsis: true,
              render: (_, row) => {
                const groupName = groupNamesByIndex[row.queueIndex] ?? EMPTY_PLACEHOLDER;
                if (groupName === EMPTY_PLACEHOLDER) {
                  return <Typography.Text type="secondary">{EMPTY_PLACEHOLDER}</Typography.Text>;
                }
                if (!isFirstStepInGroup(queue, row.queueIndex)) {
                  return (
                    <Typography.Text ellipsis title={groupName}>
                      {groupName}
                    </Typography.Text>
                  );
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
                      void persistQueue(next, { silent: true, rowIndexes: [markerIndex] });
                    }}
                  />
                );
              },
            },
            {
              title: '名称',
              width: 168,
              fixed: 'left',
              ellipsis: true,
              render: (_, row) => {
                const source = row.item.template_source === 'general' ? '通用' : 'VI';
                const kind = row.item.kind ? ` · ${row.item.kind}` : '';
                const name = row.item.name || '—';
                return (
                  <div style={{ minWidth: 0 }}>
                    <Typography.Text ellipsis title={name}>
                      {name}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                      {source}
                      {kind}
                    </Typography.Text>
                  </div>
                );
              },
            },
            {
              title: 'Spec 段',
              width: 96,
              ellipsis: true,
              render: (_, row) => {
                const markerIndex = findGroupIndexForStep(queue, row.queueIndex);
                const section =
                  markerIndex != null
                    ? String(queue[markerIndex]?.spec_section ?? '').trim()
                    : effectiveSpecSectionForStep(queue, row.queueIndex);
                if (markerIndex != null && isFirstStepInGroup(queue, row.queueIndex)) {
                  return renderGroupSpecCell(markerIndex, section);
                }
                if (!section) {
                  return <Typography.Text type="secondary">{EMPTY_PLACEHOLDER}</Typography.Text>;
                }
                return (
                  <Typography.Text style={{ fontSize: 12 }} ellipsis title={section}>
                    {section}
                  </Typography.Text>
                );
              },
            },
            ...limitValueColumns,
            {
              title: '启用',
              width: 64,
              render: (_, row) => (
                <Switch
                  size="small"
                  checked={row.item.enabled !== false}
                  disabled={savingRowIndexes.includes(row.queueIndex)}
                  onChange={(checked) => void updateAt(row.queueIndex, { enabled: checked })}
                />
              ),
            },
            {
              title: 'Fail',
              width: 96,
              render: (_, row) => (
                <Select
                  size="small"
                  value={row.item.fail_policy === 'continue' ? 'continue' : 'stop'}
                  style={{ width: 88 }}
                  disabled={savingRowIndexes.includes(row.queueIndex)}
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
              width: 112,
              ellipsis: true,
              render: (_, row) => {
                const resources = Array.isArray(row.item.resources) ? row.item.resources : [];
                if (!resources.length) return EMPTY_PLACEHOLDER;
                return (
                  <Typography.Text ellipsis title={resources.join(', ')} style={{ fontSize: 12 }}>
                    {resources.join(', ')}
                  </Typography.Text>
                );
              },
            },
            {
              title: 'Spec',
              width: 132,
              ellipsis: true,
              render: (_, row) => (
                <Typography.Text style={{ fontSize: 12 }} ellipsis>
                  {formatStepSpecSummary(
                    row.item as Record<string, unknown>,
                    resolveSectionMetricCount(row.item),
                  )}
                </Typography.Text>
              ),
            },
            {
              title: '操作',
              width: 200,
              fixed: 'right',
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
                  <Button size="small" danger onClick={() => confirmRemoveAt(row.queueIndex)}>
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
          loading={pageBusy}
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
                    onClick={() => loadTemplate(row.id!, row.name)}
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
        onClose={requestCloseDetail}
        extra={
          <Button type="primary" onClick={() => void saveDetail()} loading={detailSaving}>
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
                  {resourcesDraft.map((name) => (
                    <Tag
                      key={name}
                      closable
                      onClose={() => {
                        setResourcesDraft((prev) => prev.filter((x) => x !== name));
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
                  onPressEnter={() => addResource()}
                />
                <Button onClick={() => addResource()}>添加</Button>
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
              {detailInheritedGroupIndex != null ? (
                <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 12 }}>
                  继承自分组「{queue[detailInheritedGroupIndex]?.name || '分组'}」
                  {queue[detailInheritedGroupIndex]?.spec_section
                    ? ` · ${queue[detailInheritedGroupIndex]?.spec_section}`
                    : ''}
                </Typography.Paragraph>
              ) : (
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
                    setSpecSectionDraft('');
                    setSpecMetricsDraft([]);
                    if (nextId != null) void ensureSpecTemplateDetails([nextId]);
                  }}
                />
              )}
            </div>
            <div>
              <Typography.Text strong>Spec 段</Typography.Text>
              {detailInheritedGroupIndex != null ? (
                <Typography.Paragraph style={{ margin: '8px 0 0' }}>
                  {queue[detailInheritedGroupIndex]?.spec_section || EMPTY_PLACEHOLDER}
                </Typography.Paragraph>
              ) : (
                <>
                  <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 12 }}>
                    只能从所选 Spec 模板的 Section 列表中选择。
                  </Typography.Paragraph>
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    placeholder={
                      specTemplateDraft == null
                        ? '请先选择 Spec 模板'
                        : detailSectionOptions.length
                          ? '从模板选择 Section'
                          : '模板无可用 Section'
                    }
                    value={specSectionDraft || undefined}
                    style={{ width: '100%', marginTop: 8 }}
                    options={detailSectionOptions}
                    disabled={specTemplateDraft == null || !detailSectionOptions.length}
                    onChange={(value) => {
                      setSpecSectionDraft(value ? String(value) : '');
                      setSpecMetricsDraft([]);
                    }}
                  />
                </>
              )}
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
                  detailInheritedGroupIndex != null
                    ? '继承分组 Spec，不可单独选择'
                    : specTemplateDraft == null
                      ? '请先选择 Spec 模板'
                      : detailMetricOptions.length
                        ? '选择指标（可选）'
                        : '选择 Section 后可选指标'
                }
                value={specMetricsDraft}
                style={{ width: '100%', marginTop: 8 }}
                options={detailMetricOptions}
                disabled={
                  detailInheritedGroupIndex != null ||
                  !specTemplateDraft ||
                  !detailMetricOptions.length
                }
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
                checked={enabledDraft}
                onChange={(e) => setEnabledDraft(e.target.checked)}
              >
                启用此步骤
              </Checkbox>
              <Select
                style={{ width: 160, marginLeft: 12 }}
                value={failPolicyDraft}
                options={[
                  { value: 'stop', label: '失败则停止' },
                  { value: 'continue', label: '失败则继续' },
                ]}
                onChange={(value) => setFailPolicyDraft(value)}
              />
            </div>
          </Space>
        ) : null}
      </Drawer>

      <Modal
        title={groupNameModal === 'group' ? '编成一组' : '新建分组'}
        open={groupNameModal != null}
        onCancel={resetGroupModal}
        onOk={() => void confirmGroupName()}
        okText="确定"
        cancelText="取消"
        destroyOnClose
      >
        <Form layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item label="分组名称" required>
            <Input
              value={groupNameInput}
              onChange={(event) => setGroupNameInput(event.target.value)}
              onPressEnter={() => void confirmGroupName()}
              placeholder="如：光模块"
              maxLength={100}
              autoFocus
            />
          </Form.Item>
          <Form.Item
            label="Spec 模板（可选）"
            extra="选择后须指定 Spec 段；组内步骤将继承该判限"
          >
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="选择中心 Spec 模板"
              value={groupSpecTemplateDraft ?? undefined}
              options={specTemplates.map((tpl) => ({
                value: tpl.id,
                label: `#${tpl.id} ${tpl.name}${tpl.source_filename ? ` · ${tpl.source_filename}` : ''}`,
              }))}
              onChange={(value) => {
                const nextId = value ?? null;
                setGroupSpecTemplateDraft(nextId);
                setGroupSpecSectionDraft('');
                if (nextId != null) void ensureSpecTemplateDetails([nextId]);
              }}
            />
          </Form.Item>
          <Form.Item label="Spec 段" style={{ marginBottom: 0 }}>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder={
                groupSpecTemplateDraft == null
                  ? '请先选择 Spec 模板'
                  : groupModalSectionOptions.length
                    ? '从模板选择 Section'
                    : '模板无可用 Section'
              }
              value={groupSpecSectionDraft || undefined}
              options={groupModalSectionOptions}
              disabled={groupSpecTemplateDraft == null || !groupModalSectionOptions.length}
              onChange={(value) => setGroupSpecSectionDraft(value ? String(value) : '')}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="保存为序列模板"
        open={saveSeqTemplateOpen}
        onCancel={() => setSaveSeqTemplateOpen(false)}
        onOk={() => void confirmSaveTemplate()}
        okText="保存"
        cancelText="取消"
        confirmLoading={pageBusy}
        destroyOnClose
      >
        <Form layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item label="名称" required>
            <Input
              value={saveSeqTemplateName}
              onChange={(event) => setSaveSeqTemplateName(event.target.value)}
              placeholder="序列模板名称"
              maxLength={120}
              autoFocus
            />
          </Form.Item>
          <Form.Item label="备注（可选）" style={{ marginBottom: 0 }}>
            <Input.TextArea
              value={saveSeqTemplateNote}
              onChange={(event) => setSaveSeqTemplateNote(event.target.value)}
              placeholder="可选备注"
              rows={3}
              maxLength={500}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
