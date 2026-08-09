import {
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
import { schedulerApi } from '../api/schedulerApi';
import type { SpecTemplateDetail, SpecTemplateSummary } from '../api/types';
import { parseSpecIni } from '../utils/specIni';

type UploadPreview = {
  iniText: string;
  sourceFilename: string;
  sectionCount: number;
  metricCount: number;
  warnings: string[];
};

type SectionRow = {
  key: string;
  section: string;
  metricCount: number;
};

type MetricRow = {
  key: string;
  metric: string;
  min: string;
  max: string;
};

function formatBound(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return '∞';
  }
  return String(value);
}

function countMetrics(sections: Record<string, Record<string, unknown>>): number {
  return Object.values(sections).reduce((sum, metrics) => sum + Object.keys(metrics).length, 0);
}

export function SpecsPage() {
  const { message, modal } = AntApp.useApp();
  const [templates, setTemplates] = useState<SpecTemplateSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploadPreview, setUploadPreview] = useState<UploadPreview | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [detail, setDetail] = useState<SpecTemplateDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [form] = Form.useForm<{ name: string; product_pn: string; note: string }>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const items = await schedulerApi.listSpecTemplates();
      setTemplates(items);
    } catch (error) {
      const detailText = error instanceof Error ? error.message : String(error);
      message.error('加载 Spec 模板失败：' + detailText);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const openUploadPreview = (iniText: string, sourceFilename: string) => {
    try {
      const parsed = parseSpecIni(iniText);
      const sectionCount = Object.keys(parsed.document.sections).length;
      const metricCount = countMetrics(parsed.document.sections);
      const defaultName = sourceFilename.replace(/\.ini$/i, '') || 'Spec 模板';
      form.setFieldsValue({ name: defaultName, product_pn: '', note: '' });
      setUploadPreview({
        iniText,
        sourceFilename,
        sectionCount,
        metricCount,
        warnings: parsed.warnings,
      });
      setUploadOpen(true);
    } catch (error) {
      const detailText = error instanceof Error ? error.message : String(error);
      message.error('解析 Spec INI 失败：' + detailText);
    }
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
      setUploadOpen(false);
      setUploadPreview(null);
      form.resetFields();
      await load();
    } catch (error) {
      const detailText = error instanceof Error ? error.message : String(error);
      message.error('上传失败：' + detailText);
    } finally {
      setUploading(false);
    }
  };

  const openDetail = async (row: SpecTemplateSummary) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const data = await schedulerApi.getSpecTemplate(row.id);
      setDetail(data);
    } catch (error) {
      const detailText = error instanceof Error ? error.message : String(error);
      message.error('加载详情失败：' + detailText);
    } finally {
      setDetailLoading(false);
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
          const detail = error instanceof Error ? error.message : String(error);
          message.error('删除失败：' + detail);
          throw error;
        }
      },
    });
  };

  const columns = useMemo<ColumnsType<SpecTemplateSummary>>(
    () => [
      { title: 'ID', dataIndex: 'id', width: 72 },
      { title: '名称', dataIndex: 'name' },
      { title: '产品 PN', dataIndex: 'product_pn', render: (value) => value || '—' },
      { title: '来源文件', dataIndex: 'source_filename', render: (value) => value || '—' },
      { title: 'Sections', dataIndex: 'section_count', width: 96 },
      { title: '更新时间', dataIndex: 'updated_at', width: 200 },
      {
        title: '操作',
        width: 160,
        render: (_, row) => (
          <Space>
            <Button size="small" type="link" onClick={() => void openDetail(row)}>
              查看
            </Button>
            <Button size="small" danger onClick={() => deleteTemplate(row)}>
              删除
            </Button>
          </Space>
        ),
      },
    ],
    [],
  );

  const detailSections = useMemo<SectionRow[]>(() => {
    const sections = detail?.spec?.sections ?? {};
    return Object.entries(sections).map(([section, metrics]) => ({
      key: section,
      section,
      metricCount: Object.keys(metrics).length,
    }));
  }, [detail]);

  const detailMetrics = useMemo<MetricRow[]>(() => {
    const sections = detail?.spec?.sections ?? {};
    const rows: MetricRow[] = [];
    for (const [section, metrics] of Object.entries(sections)) {
      for (const [metric, bound] of Object.entries(metrics)) {
        rows.push({
          key: `${section}:${metric}`,
          metric: `${section} · ${metric}`,
          min: formatBound(bound.min),
          max: formatBound(bound.max),
        });
      }
    }
    return rows;
  }, [detail]);

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          Spec 模板
        </Typography.Title>
        <Space>
          <Upload
            accept=".ini,text/plain"
            showUploadList={false}
            beforeUpload={(file) => {
              const reader = new FileReader();
              reader.onload = () => {
                openUploadPreview(String(reader.result || ''), file.name);
              };
              reader.readAsText(file);
              return false;
            }}
          >
            <Button type="primary">上传 .ini</Button>
          </Upload>
          <Button onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        </Space>
      </Space>

      <Card>
        <Table
          rowKey={(row) => String(row.id)}
          columns={columns}
          dataSource={templates}
          loading={loading}
          locale={{ emptyText: '暂无 Spec 模板（请上传 *_Spec.ini）' }}
          pagination={false}
          scroll={{ x: true }}
        />
      </Card>

      <Modal
        title="上传 Spec 模板"
        open={uploadOpen}
        onCancel={() => {
          setUploadOpen(false);
          setUploadPreview(null);
          form.resetFields();
        }}
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

      <Modal
        title={detail ? `Spec 模板 · ${detail.name}` : 'Spec 模板详情'}
        open={!!detail || detailLoading}
        onCancel={() => setDetail(null)}
        footer={null}
        width={900}
        destroyOnClose
      >
        {detailLoading && !detail ? (
          <Typography.Text type="secondary">加载中…</Typography.Text>
        ) : detail ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="ID">{detail.id}</Descriptions.Item>
              <Descriptions.Item label="产品 PN">{detail.product_pn || '—'}</Descriptions.Item>
              <Descriptions.Item label="来源文件">{detail.source_filename || '—'}</Descriptions.Item>
              <Descriptions.Item label="Sections">{detail.section_count}</Descriptions.Item>
              <Descriptions.Item label="创建机台">
                {detail.created_by_agent_name || '—'}
              </Descriptions.Item>
              <Descriptions.Item label="更新时间">{detail.updated_at}</Descriptions.Item>
              <Descriptions.Item label="备注" span={2}>
                {detail.note || '—'}
              </Descriptions.Item>
            </Descriptions>
            <Typography.Title level={5}>Sections</Typography.Title>
            <Table
              size="small"
              pagination={false}
              rowKey="key"
              dataSource={detailSections}
              columns={[
                { title: 'Section', dataIndex: 'section' },
                { title: '指标数', dataIndex: 'metricCount', width: 96 },
              ]}
            />
            <Typography.Title level={5}>指标上下限</Typography.Title>
            <Table
              size="small"
              pagination={{ pageSize: 20, hideOnSinglePage: true }}
              rowKey="key"
              dataSource={detailMetrics}
              scroll={{ y: 360 }}
              columns={[
                { title: 'Section · 指标', dataIndex: 'metric' },
                { title: 'LL', dataIndex: 'min', width: 120 },
                { title: 'UL', dataIndex: 'max', width: 120 },
              ]}
            />
          </Space>
        ) : null}
      </Modal>
    </Space>
  );
}
