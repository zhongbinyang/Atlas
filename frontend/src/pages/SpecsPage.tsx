import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Space,
  Table,
  Typography,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { schedulerApi } from '../api/schedulerApi';
import type { SpecTemplateSummary } from '../api/types';
import { HelpLabel, HelpTip } from '../components/HelpTip';
import { PageHeader } from '../components/PageHeader';
import { describeApiError } from '../lib/formatError';
import { formatSpecParseError, parseSpecIni } from '../lib/specIni';
import { DEFAULT_TABLE_PAGINATION, formatTimestamp, textSorter, timestampSorter } from '../utils/tableHelpers';
import { SPEC_HELP } from './specHelp';

type UploadPreview = {
  iniText: string;
  sourceFilename: string;
  sectionCount: number;
  metricCount: number;
  sectionNames: string[];
  warnings: string[];
};

const PREVIEW_SECTION_LIMIT = 8;

function countMetrics(sections: Record<string, Record<string, unknown>>): number {
  return Object.values(sections).reduce((sum, metrics) => sum + Object.keys(metrics).length, 0);
}

function readIniFile(file: File, onSuccess: (text: string) => void, onError: (message: string) => void) {
  const reader = new FileReader();
  reader.onload = () => {
    onSuccess(String(reader.result || ''));
  };
  reader.onerror = () => {
    onError('读取文件失败，请重试或换用 UTF-8 编码的 .ini 文件');
  };
  reader.readAsText(file);
}

export function SpecsPage() {
  const { message, modal } = AntApp.useApp();
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<SpecTemplateSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploadPreview, setUploadPreview] = useState<UploadPreview | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [form] = Form.useForm<{ name: string; product_pn: string; note: string }>();
  const uploadName = Form.useWatch('name', form);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const items = await schedulerApi.listSpecTemplates();
      setTemplates(items);
    } catch (error) {
      message.error('加载 Spec 模板失败：' + describeApiError(error));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const duplicateUploadName = useMemo(() => {
    const name = uploadName?.trim().toLowerCase();
    if (!name) return false;
    return templates.some((item) => item.name.trim().toLowerCase() === name);
  }, [templates, uploadName]);

  const openUploadPreview = (iniText: string, sourceFilename: string) => {
    if (!iniText.trim()) {
      message.error('文件内容为空，请选择有效的 Spec INI 文件');
      return;
    }
    try {
      const parsed = parseSpecIni(iniText);
      const sectionNames = Object.keys(parsed.document.sections).sort((a, b) => a.localeCompare(b));
      const sectionCount = sectionNames.length;
      const metricCount = countMetrics(parsed.document.sections);
      const defaultName = sourceFilename.replace(/\.ini$/i, '') || 'Spec 模板';
      form.setFieldsValue({ name: defaultName, product_pn: '', note: '' });
      setUploadPreview({
        iniText,
        sourceFilename,
        sectionCount,
        metricCount,
        sectionNames,
        warnings: parsed.warnings,
      });
      setUploadOpen(true);
    } catch (error) {
      message.error('解析 Spec INI 失败：' + formatSpecParseError(error));
    }
  };

  const closeUploadModal = () => {
    setUploadOpen(false);
    setUploadPreview(null);
    form.resetFields();
  };

  const submitUpload = async () => {
    if (!uploadPreview) {
      return;
    }
    const values = await form.validateFields();
    setUploading(true);
    try {
      await schedulerApi.createSpecTemplate({
        ini_text: uploadPreview.iniText,
        name: values.name.trim(),
        product_pn: values.product_pn.trim(),
        note: values.note.trim(),
        source_filename: uploadPreview.sourceFilename,
      });
      message.success('Spec 模板已上传');
      closeUploadModal();
      await load();
    } catch (error) {
      message.error('上传失败：' + describeApiError(error));
    } finally {
      setUploading(false);
    }
  };

  const deleteTemplate = (template: SpecTemplateSummary) => {
    const label = template.name || String(template.id);
    modal.confirm({
      title: '确认删除',
      content: `确定删除 Spec 模板「${label}」？`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      async onOk() {
        try {
          await schedulerApi.deleteSpecTemplate(template.id);
          message.success('Spec 模板已删除');
          await load();
        } catch (error) {
          message.error('删除失败：' + describeApiError(error));
          throw error;
        }
      },
    });
  };

  const columns = useMemo<ColumnsType<SpecTemplateSummary>>(
    () => [
      { title: 'ID', dataIndex: 'id', width: 72, sorter: (a, b) => a.id - b.id },
      { title: '名称', dataIndex: 'name', sorter: textSorter('name') },
      { title: '产品 PN', dataIndex: 'product_pn', render: (value) => value || '—' },
      { title: '来源文件', dataIndex: 'source_filename', render: (value) => value || '—' },
      { title: 'Sections', dataIndex: 'section_count', width: 96, sorter: (a, b) => a.section_count - b.section_count },
      {
        title: '更新时间',
        dataIndex: 'updated_at',
        width: 180,
        defaultSortOrder: 'descend',
        sorter: (a, b) => timestampSorter(a.updated_at, b.updated_at),
        render: (value) => formatTimestamp(value),
      },
      {
        title: '操作',
        width: 160,
        fixed: 'right',
        render: (_, row) => (
          <Space>
            <Button size="small" type="link" onClick={() => navigate(`/specs/${row.id}`)}>
              编辑
            </Button>
            <Button size="small" danger onClick={() => deleteTemplate(row)}>
              删除
            </Button>
          </Space>
        ),
      },
    ],
    [navigate],
  );

  const previewSectionNames = uploadPreview?.sectionNames ?? [];
  const previewSectionOverflow =
    previewSectionNames.length > PREVIEW_SECTION_LIMIT
      ? previewSectionNames.length - PREVIEW_SECTION_LIMIT
      : 0;

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <PageHeader
        title={<HelpLabel label="Spec 模板" text={SPEC_HELP.page} />}
        extra={
          <Space>
            <Button onClick={() => navigate('/specs/new')}>新建</Button>
            <Upload
              accept=".ini,text/plain"
              showUploadList={false}
              beforeUpload={(file) => {
                readIniFile(
                  file,
                  (text) => openUploadPreview(text, file.name),
                  (errorText) => message.error(errorText),
                );
                return false;
              }}
            >
              <Button type="primary">导入 INI</Button>
            </Upload>
            <HelpTip text={SPEC_HELP.iniImport} />
            <Button onClick={() => void load()} loading={loading}>
              刷新
            </Button>
          </Space>
        }
      />

      <Card>
        <Table
          rowKey={(row) => String(row.id)}
          columns={columns}
          dataSource={templates}
          loading={loading}
          locale={{ emptyText: '暂无 Spec 模板，可新建或导入 INI' }}
          pagination={DEFAULT_TABLE_PAGINATION}
          scroll={{ x: true }}
        />
      </Card>

      <Modal
        title="上传 Spec 模板"
        open={uploadOpen}
        onCancel={closeUploadModal}
        onOk={() => void submitUpload()}
        okText="确认上传"
        confirmLoading={uploading}
        destroyOnClose
        width={560}
      >
        {uploadPreview ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="来源文件">
                {uploadPreview.sourceFilename || '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Sections">{uploadPreview.sectionCount}</Descriptions.Item>
              <Descriptions.Item label="指标数">{uploadPreview.metricCount}</Descriptions.Item>
              <Descriptions.Item label="Section 预览">
                {previewSectionNames.length ? (
                  <Space size={[4, 4]} wrap>
                    {previewSectionNames.slice(0, PREVIEW_SECTION_LIMIT).map((name) => (
                      <Typography.Text key={name} code>
                        {name}
                      </Typography.Text>
                    ))}
                    {previewSectionOverflow > 0 ? (
                      <Typography.Text type="secondary">
                        还有 {previewSectionOverflow} 个
                      </Typography.Text>
                    ) : null}
                  </Space>
                ) : (
                  '—'
                )}
              </Descriptions.Item>
            </Descriptions>
            {uploadPreview.warnings.length > 0 ? (
              <Typography.Text type="warning">
                解析警告：{uploadPreview.warnings.join('；')}
              </Typography.Text>
            ) : null}
            <Form form={form} layout="vertical">
              <Form.Item
                label="名称"
                name="name"
                rules={[{ required: true, message: '请输入模板名称' }]}
              >
                <Input placeholder="Spec 模板名称" />
              </Form.Item>
              {duplicateUploadName ? (
                <Alert
                  type="warning"
                  showIcon
                  message="已有同名 Spec 模板，上传后中心将并存多个模板，建议使用更易区分的名称。"
                />
              ) : null}
              <Form.Item label="产品 PN" name="product_pn">
                <Input placeholder="可选" />
              </Form.Item>
              <Form.Item label="备注" name="note">
                <Input.TextArea rows={2} placeholder="可选" />
              </Form.Item>
            </Form>
          </Space>
        ) : null}
      </Modal>
    </Space>
  );
}
