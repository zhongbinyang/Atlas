import {
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Row,
  Space,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useState } from 'react';
import { agentApi } from '../api/agentApi';
import { ApiError } from '../api/client';
import type { LabviewConfig } from '../api/types';
import { JsonBlock, JsonFieldHint } from '../components/JsonBlock';
import { PageHeader } from '../components/PageHeader';

type ViTemplate = {
  id?: string | number;
  name?: string;
  origin_agent_name?: string;
  vi_path?: string;
  inputs?: unknown;
  outputs?: unknown;
  show_front_panel?: boolean;
  timeout_secs?: number;
};

const getErrorMessage = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : String(error);

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const prettyJson = (value: unknown) => JSON.stringify(value ?? [], null, 2);

/** Parse VI inputs JSON text into the array payload expected by LabVIEW APIs. */
export function parseViInputsJson(text: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || '[]');
  } catch (error) {
    throw new Error(`入参 JSON 无效: ${getErrorMessage(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('入参 JSON 必须是数组');
  }
  return parsed;
}

export function ViPage() {
  const { message } = App.useApp();
  const [config, setConfig] = useState<LabviewConfig>({});
  const [viPath, setViPath] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inputsJson, setInputsJson] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<unknown[]>([]);
  const [showFrontPanel, setShowFrontPanel] = useState(false);
  const [timeoutSecs, setTimeoutSecs] = useState<number | null>(null);
  const [runResult, setRunResult] = useState<unknown>(null);
  const [templates, setTemplates] = useState<ViTemplate[]>([]);
  const [templateQuery, setTemplateQuery] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [running, setRunning] = useState(false);
  const [registering, setRegistering] = useState(false);

  const loadConfig = async () => {
    try {
      setConfig(await agentApi.labviewConfig());
    } catch (error) {
      message.error(`加载 LabVIEW 配置失败: ${getErrorMessage(error)}`);
    }
  };

  const loadTemplates = async () => {
    try {
      const data = await agentApi.labviewAllTemplates();
      setTemplates(data.map((template) => asRecord(template) as ViTemplate));
    } catch (error) {
      message.error(`加载已注册 VI 功能失败: ${getErrorMessage(error)}`);
    }
  };

  useEffect(() => {
    void loadConfig();
    void loadTemplates();
  }, []);

  const applyInputs = (nextInputs: unknown) => {
    setInputsJson(prettyJson(Array.isArray(nextInputs) ? nextInputs : []));
    setRunResult(null);
  };

  const handleInspect = async () => {
    if (!viPath.trim()) {
      message.error('请填写 VI 路径');
      return;
    }
    setInspecting(true);
    try {
      const result = asRecord(await agentApi.labviewInspect({ vi_path: viPath.trim() }));
      applyInputs(result.inputs);
      setOutputs(Array.isArray(result.outputs) ? result.outputs : []);
      message.success('参数已加载');
    } catch (error) {
      message.error(`查询失败: ${getErrorMessage(error)}`);
    } finally {
      setInspecting(false);
    }
  };

  const runOptions = () => {
    if (timeoutSecs !== null && timeoutSecs <= 0) throw new Error('超时必须是正整数');
    return {
      show_front_panel: showFrontPanel,
      ...(timeoutSecs !== null ? { timeout_secs: timeoutSecs } : {}),
    };
  };

  const handleRun = async () => {
    if (!viPath.trim() || inputsJson === null) return;
    setRunning(true);
    setRunResult(null);
    try {
      const inputs = parseViInputsJson(inputsJson);
      const result = await agentApi.labviewRun({
        vi_path: viPath.trim(),
        inputs,
        ...runOptions(),
      });
      setRunResult(result);
      message.success('试跑完成');
    } catch (error) {
      message.error(`试跑失败: ${getErrorMessage(error)}`);
    } finally {
      setRunning(false);
    }
  };

  const handleRegister = async () => {
    if (!displayName.trim()) {
      message.error('请填写显示名称');
      return;
    }
    if (!viPath.trim() || inputsJson === null) return;
    setRegistering(true);
    try {
      const inputs = parseViInputsJson(inputsJson);
      await agentApi.labviewRegisterTemplate({
        vi_path: viPath.trim(),
        name: displayName.trim(),
        inputs,
        outputs,
        ...runOptions(),
      });
      message.success('注册成功');
      await loadTemplates();
    } catch (error) {
      message.error(`注册失败: ${getErrorMessage(error)}`);
    } finally {
      setRegistering(false);
    }
  };

  const loadTemplateToEditor = (template: ViTemplate) => {
    setViPath(template.vi_path ?? '');
    setDisplayName(template.name ?? '');
    applyInputs(template.inputs);
    setOutputs(Array.isArray(template.outputs) ? template.outputs : []);
    setShowFrontPanel(Boolean(template.show_front_panel));
    setTimeoutSecs(template.timeout_secs ?? null);
    message.success(`已加载: ${template.name ?? template.id ?? ''}`);
  };

  const filteredTemplates = templates.filter((template) => {
    const query = templateQuery.trim().toLowerCase();
    if (!query) return true;
    return [template.id, template.name, template.origin_agent_name, template.vi_path].some((value) =>
      String(value ?? '')
        .toLowerCase()
        .includes(query),
    );
  });

  const templateColumns: ColumnsType<ViTemplate> = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 72 },
    { title: '名称', dataIndex: 'name', key: 'name', ellipsis: true },
    { title: '来源机台', dataIndex: 'origin_agent_name', key: 'origin_agent_name', width: 140, ellipsis: true },
    { title: 'VI 路径', dataIndex: 'vi_path', key: 'vi_path', ellipsis: true },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      render: (_, template) => (
        <Button
          size="small"
          type="link"
          disabled={inspecting || running || registering}
          onClick={() => loadTemplateToEditor(template)}
        >
          加载
        </Button>
      ),
    },
  ];

  const busy = inspecting || running || registering;

  return (
    <div className="atlas-page">
      <PageHeader
        title="VI"
        description="查询 LabVIEW 参数、试跑并注册到中心。入参以 JSON 数组编辑。"
        extra={
          <Button onClick={() => void loadTemplates()} disabled={busy}>
            刷新列表
          </Button>
        }
      />

      <Card size="small" title="本机 LabVIEW">
        <Descriptions column={{ xs: 1, sm: 2 }} size="small">
          <Descriptions.Item label="CLI">{String(config.cli_path ?? '—')}</Descriptions.Item>
          <Descriptions.Item label="GetInfo">{String(config.getinfo_path ?? '—')}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card title="工作台">
            <Form layout="vertical" requiredMark="optional">
              <Form.Item label="VI 路径" required>
                <Space.Compact style={{ width: '100%' }}>
                  <Input
                    value={viPath}
                    disabled={busy}
                    onChange={(event) => {
                      setViPath(event.target.value);
                      setInputsJson(null);
                      setOutputs([]);
                      setRunResult(null);
                    }}
                    placeholder="C:\path\Example.vi"
                  />
                  <Button type="primary" loading={inspecting} disabled={busy && !inspecting} onClick={handleInspect}>
                    查询参数
                  </Button>
                </Space.Compact>
              </Form.Item>

              <Form.Item label="入参 JSON" required>
                <JsonFieldHint>数组元素通常含 name / className / value。</JsonFieldHint>
                <Input.TextArea
                  className="atlas-mono-textarea"
                  rows={14}
                  value={inputsJson ?? ''}
                  disabled={busy || inputsJson === null}
                  placeholder={inputsJson === null ? '请先查询参数或从下方加载模板' : '[]'}
                  onChange={(event) => setInputsJson(event.target.value)}
                />
              </Form.Item>

              <Space wrap size="middle" style={{ marginBottom: 16 }}>
                <Checkbox
                  checked={showFrontPanel}
                  disabled={busy || inputsJson === null}
                  onChange={(event) => setShowFrontPanel(event.target.checked)}
                >
                  显示前面板
                </Checkbox>
                <InputNumber
                  min={1}
                  value={timeoutSecs}
                  disabled={busy || inputsJson === null}
                  onChange={setTimeoutSecs}
                  placeholder="超时（秒）"
                  addonAfter="秒"
                  style={{ width: 140 }}
                />
                <Button
                  type="primary"
                  loading={running}
                  disabled={inputsJson === null || (busy && !running)}
                  onClick={handleRun}
                >
                  试跑
                </Button>
              </Space>

              <Form.Item label="显示名称" required style={{ marginBottom: 12 }}>
                <Space.Compact style={{ width: '100%', maxWidth: 480 }}>
                  <Input
                    value={displayName}
                    disabled={busy}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="注册到中心的名称"
                  />
                  <Button
                    loading={registering}
                    disabled={inputsJson === null || (busy && !registering)}
                    onClick={handleRegister}
                  >
                    注册到中心
                  </Button>
                </Space.Compact>
              </Form.Item>
            </Form>
          </Card>
        </Col>

        <Col xs={24} xl={10}>
          <Card title="试跑输出" style={{ marginBottom: 16 }}>
            <JsonBlock
              value={runResult != null ? JSON.stringify(runResult, null, 2) : ''}
              emptyText="试跑结果将显示在这里"
            />
          </Card>
          {outputs.length > 0 ? (
            <Card title="输出端子" size="small">
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 12 }}>
                查询参数时从 VI 读取，注册时一并提交。
              </Typography.Paragraph>
              <JsonBlock value={JSON.stringify(outputs, null, 2)} maxHeight={240} />
            </Card>
          ) : null}
        </Col>
      </Row>

      <Card
        title="中心已注册 VI"
        extra={
          <Input
            allowClear
            value={templateQuery}
            onChange={(event) => setTemplateQuery(event.target.value)}
            placeholder="搜索名称、路径或机台"
            style={{ width: 220 }}
          />
        }
      >
        <Table
          size="middle"
          columns={templateColumns}
          dataSource={filteredTemplates}
          pagination={{ pageSize: 8, showSizeChanger: false }}
          locale={{ emptyText: '暂无已注册 VI' }}
          rowKey={(template) => String(template.id ?? template.vi_path ?? template.name)}
        />
      </Card>
    </div>
  );
}
