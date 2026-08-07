import {
  App,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Space,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useState } from 'react';
import { agentApi } from '../api/agentApi';
import { ApiError } from '../api/client';
import type { LabviewConfig } from '../api/types';

type ViInput = {
  name: string;
  className: string;
  value: unknown;
  isJson: boolean;
};

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

const normalizeInputs = (value: unknown): ViInput[] =>
  Array.isArray(value)
    ? value.map((item) => {
        const input = asRecord(item);
        return {
          name: String(input.name ?? ''),
          className: String(input.className ?? ''),
          value: input.value ?? null,
          isJson: input.value !== null && typeof input.value === 'object',
        };
      })
    : [];

export function parseViInputValue(value: string, isJson: boolean): unknown {
  if (isJson) {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw new Error(`JSON 无效: ${getErrorMessage(error)}`);
    }
  }

  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true';
  return value;
}

export function ViPage() {
  const { message } = App.useApp();
  const [config, setConfig] = useState<LabviewConfig>({});
  const [viPath, setViPath] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inputs, setInputs] = useState<ViInput[] | null>(null);
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

  const applyInputs = (nextInputs: ViInput[]) => {
    setInputs(nextInputs);
    setRunResult(null);
  };

  const readInputs = (): ViInput[] =>
    (inputs ?? []).map((input) => {
      return {
        ...input,
        value: parseViInputValue(
          input.isJson
            ? typeof input.value === 'string'
              ? input.value
              : JSON.stringify(input.value)
            : String(input.value ?? ''),
          input.isJson,
        ),
      };
    });

  const handleInspect = async () => {
    if (!viPath.trim()) {
      message.error('请填写 VI 路径');
      return;
    }
    setInspecting(true);
    try {
      const result = asRecord(await agentApi.labviewInspect({ vi_path: viPath.trim() }));
      applyInputs(normalizeInputs(result.inputs));
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
    if (!viPath.trim() || inputs === null) return;
    setRunning(true);
    setRunResult(null);
    try {
      const result = await agentApi.labviewRun({
        vi_path: viPath.trim(),
        inputs: readInputs(),
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
    if (!viPath.trim() || inputs === null) return;
    setRegistering(true);
    try {
      await agentApi.labviewRegisterTemplate({
        vi_path: viPath.trim(),
        name: displayName.trim(),
        inputs: readInputs(),
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
    applyInputs(normalizeInputs(template.inputs));
    setOutputs(Array.isArray(template.outputs) ? template.outputs : []);
    setShowFrontPanel(Boolean(template.show_front_panel));
    setTimeoutSecs(template.timeout_secs ?? null);
    message.success(`已加载到编辑区: ${template.name ?? template.id ?? ''}`);
  };

  const inputColumns: ColumnsType<ViInput> = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '类型', dataIndex: 'className', key: 'className' },
    {
      title: '值',
      key: 'value',
      render: (_, input, index) => {
        const value =
          input.isJson && typeof input.value !== 'string'
            ? JSON.stringify(input.value)
            : String(input.value ?? '');
        const updateValue = (nextValue: string) => {
          setInputs((current) =>
            current?.map((item, itemIndex) =>
              itemIndex === index ? { ...item, value: nextValue } : item,
            ) ?? null,
          );
        };
        return input.isJson ? (
          <Input.TextArea value={value} rows={2} onChange={(event) => updateValue(event.target.value)} />
        ) : (
          <Input value={value} onChange={(event) => updateValue(event.target.value)} />
        );
      },
    },
  ];

  const filteredTemplates = templates.filter((template) => {
    const query = templateQuery.trim().toLowerCase();
    if (!query) return true;
    return [template.id, template.name, template.origin_agent_name, template.vi_path].some((value) =>
      String(value ?? '').toLowerCase().includes(query),
    );
  });

  const templateColumns: ColumnsType<ViTemplate> = [
    { title: 'ID', dataIndex: 'id', key: 'id' },
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '来源机台', dataIndex: 'origin_agent_name', key: 'origin_agent_name' },
    { title: 'VI 路径', dataIndex: 'vi_path', key: 'vi_path' },
    {
      title: '操作',
      key: 'actions',
      render: (_, template) => (
        <Button disabled={inspecting || running || registering} onClick={() => loadTemplateToEditor(template)}>
          加载到编辑区
        </Button>
      ),
    },
  ];

  const busy = inspecting || running || registering;

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <Card title="LabVIEW 配置">
        <Descriptions column={1} size="small">
          <Descriptions.Item label="CLI">{String(config.cli_path ?? '—')}</Descriptions.Item>
          <Descriptions.Item label="GetInfo">{String(config.getinfo_path ?? '—')}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="VI 工作台">
        <Form layout="vertical">
          <Form.Item label="VI 路径" required>
            <Space.Compact style={{ width: '100%' }}>
              <Input
                value={viPath}
                disabled={busy}
                onChange={(event) => {
                  setViPath(event.target.value);
                  setInputs(null);
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

          <Table
            columns={inputColumns}
            dataSource={inputs ?? []}
            rowKey={(_, index) => String(index)}
            pagination={false}
            locale={{ emptyText: inputs === null ? '请先查询参数' : '无输入参数' }}
          />

          <Space wrap style={{ marginTop: 16 }}>
            <Checkbox checked={showFrontPanel} disabled={busy || inputs === null} onChange={(event) => setShowFrontPanel(event.target.checked)}>
              显示前面板
            </Checkbox>
            <InputNumber
              min={1}
              value={timeoutSecs}
              disabled={busy || inputs === null}
              onChange={setTimeoutSecs}
              placeholder="超时（秒）"
            />
            <Button type="primary" loading={running} disabled={inputs === null || busy && !running} onClick={handleRun}>
              试跑
            </Button>
          </Space>

          <Form.Item label="显示名称" required style={{ marginTop: 16, marginBottom: 8 }}>
            <Input
              value={displayName}
              disabled={busy}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="注册到中心的名称"
            />
          </Form.Item>
          <Button loading={registering} disabled={inputs === null || busy && !registering} onClick={handleRegister}>
            注册
          </Button>
        </Form>

        {runResult !== null && (
          <Card size="small" title="试跑输出" style={{ marginTop: 16 }}>
            <Typography.Paragraph>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(runResult, null, 2)}</pre>
            </Typography.Paragraph>
          </Card>
        )}
      </Card>

      <Card title="已注册 VI 功能" extra={<Input value={templateQuery} onChange={(event) => setTemplateQuery(event.target.value)} placeholder="搜索名称、路径或机台" allowClear />}>
        <Table columns={templateColumns} dataSource={filteredTemplates} rowKey={(template) => String(template.id ?? template.vi_path ?? template.name)} />
      </Card>
    </Space>
  );
}
