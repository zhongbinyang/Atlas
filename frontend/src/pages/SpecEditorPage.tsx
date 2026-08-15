import { App as AntApp, Button, Card, Input, Space, Spin, Table, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  type EditableSpecRow,
} from '../lib/specIni';
import { EDITOR_TABLE_PAGINATION } from '../utils/tableHelpers';
import { runOrConfirmUnsaved } from './leaveConfirm';
import { SPEC_HELP } from './specHelp';

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
  const [rows, setRows] = useState<EditableSpecRow[]>([
    { _key: specRowKey(), section: '', metric: '', min: '', max: '' },
  ]);
  const savedRef = useRef('');

  const snapshot = (nextName: string, nextPn: string, nextNote: string, nextRows: EditableSpecRow[]) =>
    JSON.stringify({ name: nextName, productPn: nextPn, note: nextNote, rows: nextRows });

  const dirty = savedRef.current !== '' && snapshot(name, productPn, note, rows) !== savedRef.current;

  const fill = (data: SpecTemplateDetail | null) => {
    const nextName = data?.name || 'Spec 模板';
    const nextPn = data?.product_pn || '';
    const nextNote = data?.note || '';
    const parsed = data ? specToEditableRows(data.spec) : [];
    const nextRows =
      parsed.length > 0
        ? parsed
        : [{ _key: specRowKey(), section: '', metric: '', min: '', max: '' }];
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

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <PageHeader
        title={editing ? `编辑 Spec · ${editing.name}` : '新建 Spec 模板'}
        onBack={goBack}
        extra={
          <Button type="primary" loading={saving} onClick={() => void save()}>
            保存
          </Button>
        }
      />

      <Spin spinning={loading}>
        <Card>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Input
              addonBefore="名称"
              maxLength={128}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Input
              addonBefore="产品 PN"
              value={productPn}
              onChange={(event) => setProductPn(event.target.value)}
            />
            <Input.TextArea
              rows={2}
              placeholder="备注（可选）"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <Space>
              <Button
                onClick={() =>
                  setRows((current) => [
                    ...current,
                    { _key: specRowKey(), section: '', metric: '', min: '', max: '' },
                  ])
                }
              >
                添加指标
              </Button>
              <Typography.Text type="secondary">留空或 inf 表示不限制</Typography.Text>
            </Space>
            <Table
              size="small"
              pagination={EDITOR_TABLE_PAGINATION}
              rowKey={(row) => row._key}
              dataSource={rows}
              locale={{ emptyText: '暂无指标，可添加或导入 INI' }}
              columns={[
                {
                  title: <HelpLabel label="Section" text={SPEC_HELP.section} />,
                  dataIndex: 'section',
                  render: (value: string, row) => (
                    <Input
                      value={value}
                      onChange={(event) =>
                        setRows((current) =>
                          current.map((item) =>
                            item._key === row._key ? { ...item, section: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  ),
                },
                {
                  title: <HelpLabel label="指标" text={SPEC_HELP.metric} />,
                  dataIndex: 'metric',
                  render: (value: string, row) => (
                    <Input
                      value={value}
                      onChange={(event) =>
                        setRows((current) =>
                          current.map((item) =>
                            item._key === row._key ? { ...item, metric: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  ),
                },
                {
                  title: <HelpLabel label="LL" text={SPEC_HELP.min} />,
                  dataIndex: 'min',
                  width: 120,
                  render: (value: string, row) => (
                    <Input
                      value={value}
                      onChange={(event) =>
                        setRows((current) =>
                          current.map((item) =>
                            item._key === row._key ? { ...item, min: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  ),
                },
                {
                  title: <HelpLabel label="UL" text={SPEC_HELP.max} />,
                  dataIndex: 'max',
                  width: 120,
                  render: (value: string, row) => (
                    <Input
                      value={value}
                      onChange={(event) =>
                        setRows((current) =>
                          current.map((item) =>
                            item._key === row._key ? { ...item, max: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  ),
                },
                {
                  title: '',
                  width: 72,
                  render: (_, row) => (
                    <Button
                      danger
                      size="small"
                      onClick={() =>
                        setRows((current) => current.filter((item) => item._key !== row._key))
                      }
                    >
                      删除
                    </Button>
                  ),
                },
              ]}
            />
          </Space>
        </Card>
      </Spin>
    </Space>
  );
}
