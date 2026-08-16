import { App as AntApp, Button, Card, Form, Input, Space, Spin, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { schedulerApi } from '../api/schedulerApi';
import type { SpecTemplateDetail } from '../api/types';
import { HelpLabel } from '../components/HelpTip';
import { PageHeader } from '../components/PageHeader';
import { describeApiError } from '../lib/formatError';
import {
  prepareSpecFromRows,
  specRowKey,
  specToEditableRows,
  suggestSaveAsName,
  type EditableSpecRow,
} from '../lib/specIni';
import { insertAtPageStart, matchesTableQuery } from '../utils/tableHelpers';
import { useTablePagination } from '../utils/useTablePagination';
import { runOrConfirmUnsaved } from './leaveConfirm';
import { SaveAsSpecModal, type SaveAsSpecValues } from './SaveAsSpecModal';
import { SPEC_HELP } from './specHelp';

function emptyRow(): EditableSpecRow {
  return { _key: specRowKey(), section: '', metric: '', min: '', max: '' };
}

export function SpecEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { message, modal } = AntApp.useApp();
  const isNew = !id;
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<SpecTemplateDetail | null>(null);
  const [name, setName] = useState('Spec 模板');
  const [productPn, setProductPn] = useState('');
  const [note, setNote] = useState('');
  const [rows, setRows] = useState<EditableSpecRow[]>([emptyRow()]);
  const [query, setQuery] = useState('');
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [savingAs, setSavingAs] = useState(false);
  const { current, pageSize, pagination, showFirstPage } = useTablePagination();
  const savedRef = useRef('');

  const snapshot = (nextName: string, nextPn: string, nextNote: string, nextRows: EditableSpecRow[]) =>
    JSON.stringify({ name: nextName, productPn: nextPn, note: nextNote, rows: nextRows });

  const dirty = savedRef.current !== '' && snapshot(name, productPn, note, rows) !== savedRef.current;

  const fill = (data: SpecTemplateDetail | null) => {
    const nextName = data?.name || 'Spec 模板';
    const nextPn = data?.product_pn || '';
    const nextNote = data?.note || '';
    const parsed = data ? specToEditableRows(data.spec) : [];
    const nextRows = parsed.length > 0 ? parsed : [emptyRow()];
    setEditing(data);
    setName(nextName);
    setProductPn(nextPn);
    setNote(nextNote);
    setRows(nextRows);
    savedRef.current = snapshot(nextName, nextPn, nextNote, nextRows);
  };

  const load = useCallback(async () => {
    if (!id) {
      fill(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await schedulerApi.getSpecTemplate(id);
      fill(data);
    } catch (error) {
      message.error('加载详情失败：' + describeApiError(error));
      navigate('/specs', { replace: true });
    } finally {
      setLoading(false);
    }
  }, [id, message, navigate]);

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

  const goBack = () => {
    runOrConfirmUnsaved(modal.confirm, dirty, () => navigate('/specs'));
  };

  const refresh = () => {
    runOrConfirmUnsaved(modal.confirm, dirty, () => void load());
  };

  const updateRow = useCallback((key: string, patch: Partial<EditableSpecRow>) => {
    setRows((current) => current.map((row) => (row._key === key ? { ...row, ...patch } : row)));
  }, []);

  const removeRow = useCallback((key: string) => {
    setRows((current) => current.filter((row) => row._key !== key));
  }, []);

  const addRow = useCallback(() => {
    setQuery('');
    setRows((currentRows) => insertAtPageStart(currentRows, emptyRow(), current, pageSize));
  }, [current, pageSize]);

  const visibleRows = useMemo(
    () =>
      rows.filter((row) => matchesTableQuery(query, [row.section, row.metric, row.min, row.max])),
    [query, rows],
  );

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      message.error('名称不能为空');
      return;
    }
    const prepared = prepareSpecFromRows(rows);
    if (!prepared.ok) {
      message.error(prepared.error);
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const updated = await schedulerApi.updateSpecTemplate(editing.id, {
          name: trimmed,
          product_pn: productPn.trim(),
          note: note.trim(),
          source_filename: editing.source_filename,
          spec: prepared.spec,
        });
        message.success('Spec 模板已保存');
        fill(updated);
      } else {
        const created = await schedulerApi.createSpecTemplate({
          name: trimmed,
          product_pn: productPn.trim(),
          note: note.trim(),
          spec: prepared.spec,
        });
        message.success('已新建 Spec 模板');
        navigate(`/specs/${created.id}`, { replace: true });
      }
    } catch (error) {
      message.error('保存失败：' + describeApiError(error));
    } finally {
      setSaving(false);
    }
  };

  const openSaveAs = () => {
    const prepared = prepareSpecFromRows(rows);
    if (!prepared.ok) {
      message.error(prepared.error);
      return;
    }
    setSaveAsOpen(true);
  };

  const confirmSaveAs = async (values: SaveAsSpecValues) => {
    if (!values.name) {
      message.error('名称不能为空');
      return;
    }
    const prepared = prepareSpecFromRows(rows);
    if (!prepared.ok) {
      message.error(prepared.error);
      return;
    }
    setSavingAs(true);
    try {
      const created = await schedulerApi.createSpecTemplate({
        name: values.name,
        product_pn: values.product_pn,
        note: values.note,
        spec: prepared.spec,
        source_filename: editing?.source_filename,
      });
      message.success('已另存为 Spec 模板');
      setSaveAsOpen(false);
      navigate(`/specs/${created.id}`, { replace: true });
    } catch (error) {
      message.error('另存为失败：' + describeApiError(error));
    } finally {
      setSavingAs(false);
    }
  };

  const columns = useMemo<ColumnsType<EditableSpecRow>>(
    () => [
      {
        title: <HelpLabel label="Section" text={SPEC_HELP.section} />,
        dataIndex: 'section',
        render: (value, record) => (
          <Input
            variant="borderless"
            size="small"
            value={String(value || '')}
            onChange={(event) => updateRow(record._key, { section: event.target.value })}
          />
        ),
      },
      {
        title: <HelpLabel label="指标" text={SPEC_HELP.metric} />,
        dataIndex: 'metric',
        render: (value, record) => (
          <Input
            variant="borderless"
            size="small"
            value={String(value || '')}
            onChange={(event) => updateRow(record._key, { metric: event.target.value })}
          />
        ),
      },
      {
        title: <HelpLabel label="LL" text={SPEC_HELP.min} />,
        dataIndex: 'min',
        width: 140,
        render: (value, record) => (
          <Input
            variant="borderless"
            size="small"
            value={String(value || '')}
            onChange={(event) => updateRow(record._key, { min: event.target.value })}
          />
        ),
      },
      {
        title: <HelpLabel label="UL" text={SPEC_HELP.max} />,
        dataIndex: 'max',
        width: 140,
        render: (value, record) => (
          <Input
            variant="borderless"
            size="small"
            value={String(value || '')}
            onChange={(event) => updateRow(record._key, { max: event.target.value })}
          />
        ),
      },
      {
        title: '操作',
        width: 80,
        fixed: 'right',
        render: (_, record) => (
          <Button danger size="small" onClick={() => removeRow(record._key)}>
            删除
          </Button>
        ),
      },
    ],
    [removeRow, updateRow],
  );

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <PageHeader
        title={editing ? `编辑 Spec · ${editing.name}` : '新建 Spec 模板'}
        description="编辑 Section 与指标上下限。留空或 inf 表示不限制。"
        onBack={goBack}
        extra={
          <Space>
            <Button onClick={addRow}>新建</Button>
            {editing ? (
              <Button onClick={openSaveAs} loading={savingAs}>
                另存为
              </Button>
            ) : null}
            <Button type="primary" onClick={() => void save()} loading={saving}>
              保存
            </Button>
            <Button onClick={refresh} loading={loading}>
              刷新
            </Button>
          </Space>
        }
      />

      <Spin spinning={loading}>
        <Card>
          <Form layout="vertical" style={{ marginBottom: 8 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(220px, 1fr) minmax(180px, 1fr)',
                gap: '0 24px',
              }}
            >
              <Form.Item label="名称" required style={{ marginBottom: 16 }}>
                <Input
                  maxLength={128}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Form.Item>
              <Form.Item label="产品 PN" style={{ marginBottom: 16 }}>
                <Input
                  value={productPn}
                  onChange={(event) => setProductPn(event.target.value)}
                />
              </Form.Item>
            </div>
            <Form.Item label="备注" style={{ marginBottom: 16 }}>
              <Input
                placeholder="可选"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </Form.Item>
          </Form>
          <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
            <Space wrap align="center">
              <Typography.Text>筛选</Typography.Text>
              <Input
                allowClear
                placeholder="Section、指标、LL 或 UL"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  showFirstPage();
                }}
                style={{ width: 280 }}
              />
            </Space>
            <Table
              rowKey={(record) => record._key}
              columns={columns}
              dataSource={visibleRows}
              locale={{ emptyText: query.trim() ? '无匹配指标' : '暂无指标，可新建或导入 INI' }}
              pagination={pagination}
              scroll={{ x: true }}
            />
          </Space>
        </Card>
      </Spin>

      <SaveAsSpecModal
        open={saveAsOpen}
        confirmLoading={savingAs}
        sourceName={editing?.name}
        initial={{
          name: suggestSaveAsName(name),
          product_pn: productPn,
          note,
        }}
        onCancel={() => setSaveAsOpen(false)}
        onSubmit={(values) => void confirmSaveAs(values)}
      />
    </Space>
  );
}
