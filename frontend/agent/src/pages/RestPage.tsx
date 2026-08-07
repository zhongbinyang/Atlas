import { App, Button, Card, Col, Form, Input, InputNumber, Row, Select, Space, Table, Tag } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { agentApi } from '../api/agentApi';
import { ApiError } from '../api/client';
import { JsonBlock, JsonFieldHint } from '../components/JsonBlock';
import { PageHeader } from '../components/PageHeader';

type RestTemplate = {
  id?: string | number;
  name?: string;
  origin_agent_name?: string;
  inputs?: unknown;
};

type RestResponse = {
  ok?: boolean;
  status?: number;
  error?: unknown;
  body_json?: unknown;
  body_text?: string;
  [key: string]: unknown;
};

const getErrorMessage = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : String(error);

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const parseJsonObject = (text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } => {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '必须是 JSON object' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
};

const inputValue = (inputs: unknown, name: string): string => {
  if (!Array.isArray(inputs)) return '';
  const found = inputs.find((item) => asRecord(item).name === name);
  const value = asRecord(found).value;
  return value == null ? '' : String(value);
};

export function RestPage() {
  const { message } = App.useApp();
  const [name, setName] = useState('');
  const [method, setMethod] = useState('GET');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState('{\n}');
  const [body, setBody] = useState('');
  const [timeoutMs, setTimeoutMs] = useState<number | null>(10000);
  const [expectStatus, setExpectStatus] = useState<number | null>(200);
  const [busy, setBusy] = useState(false);
  const [lastResponse, setLastResponse] = useState<RestResponse | null>(null);
  const [responseText, setResponseText] = useState('');
  const [templates, setTemplates] = useState<RestTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);

  const loadTemplates = useCallback(async () => {
    setLoadingTemplates(true);
    try {
      const data = await agentApi.restTemplates();
      setTemplates(Array.isArray(data) ? (data as RestTemplate[]) : []);
    } catch (error) {
      message.error(`加载 REST 模板失败: ${getErrorMessage(error)}`);
    } finally {
      setLoadingTemplates(false);
    }
  }, [message]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  const run = async () => {
    if (!url.trim()) {
      message.error('URL 不能为空');
      return;
    }
    if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      message.error('请输入有效的超时毫秒数');
      return;
    }
    if (expectStatus == null || !Number.isFinite(expectStatus) || expectStatus < 100) {
      message.error('请输入有效的期望状态码');
      return;
    }
    const headersParsed = parseJsonObject(headers);
    if (!headersParsed.ok) {
      message.error(`Headers 必须是 JSON object: ${headersParsed.error}`);
      return;
    }

    setBusy(true);
    try {
      const data = (await agentApi.restRun({
        method,
        url: url.trim(),
        headers: JSON.stringify(headersParsed.value),
        body,
        timeout_ms: Math.round(timeoutMs),
        expect_status: Math.round(expectStatus),
      })) as RestResponse;
      setLastResponse(data);
      setResponseText(JSON.stringify(data, null, 2));
      if (data.ok) message.success(`试跑完成 HTTP ${String(data.status ?? '')}`);
      else message.warning(`试跑完成但未达期望状态码: ${String(data.error ?? data.status ?? '')}`);
    } catch (error) {
      message.error(`试跑失败: ${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const register = async () => {
    if (!name.trim()) {
      message.error('名称不能为空');
      return;
    }
    if (!url.trim()) {
      message.error('URL 不能为空');
      return;
    }
    if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      message.error('请输入有效的超时毫秒数');
      return;
    }
    if (expectStatus == null || !Number.isFinite(expectStatus) || expectStatus < 100) {
      message.error('请输入有效的期望状态码');
      return;
    }
    const headersParsed = parseJsonObject(headers);
    if (!headersParsed.ok) {
      message.error(`Headers 必须是 JSON object: ${headersParsed.error}`);
      return;
    }
    if (!lastResponse || lastResponse.body_json == null) {
      message.error('请先试跑成功后再注册（需用响应 body 作为 outputs）');
      return;
    }
    if (typeof lastResponse.body_json !== 'object' || Array.isArray(lastResponse.body_json)) {
      message.error('请先试跑并得到 JSON object 响应体，再注册（outputs 需为对象）');
      return;
    }

    setBusy(true);
    try {
      const data = asRecord(
        await agentApi.restRegister({
          name: name.trim(),
          method,
          url: url.trim(),
          headers: JSON.stringify(headersParsed.value),
          body,
          timeout_ms: Math.round(timeoutMs),
          expect_status: Math.round(expectStatus),
          outputs: lastResponse.body_json,
        }),
      );
      message.success(`已注册: ${String(data.name ?? name)} (ID ${String(data.id ?? '—')})`);
      await loadTemplates();
    } catch (error) {
      message.error(`注册失败: ${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const loadTemplate = (t: RestTemplate) => {
    setName(String(t.name ?? ''));
    setMethod(String(inputValue(t.inputs, 'method') || 'GET').toUpperCase());
    setUrl(inputValue(t.inputs, 'url'));
    const hdr = inputValue(t.inputs, 'headers') || '{}';
    try {
      setHeaders(JSON.stringify(JSON.parse(hdr), null, 2));
    } catch {
      setHeaders(hdr);
    }
    setBody(inputValue(t.inputs, 'body'));
    const timeout = Number(inputValue(t.inputs, 'timeout_ms'));
    const expect = Number(inputValue(t.inputs, 'expect_status'));
    if (Number.isFinite(timeout)) setTimeoutMs(timeout);
    if (Number.isFinite(expect)) setExpectStatus(expect);
    message.success('已加载到编辑区');
  };

  return (
    <div className="atlas-page">
      <PageHeader
        title="REST"
        description="试跑 HTTP 请求；成功拿到 JSON object 响应体后可注册到中心。"
        extra={
          <Button onClick={() => void loadTemplates()} loading={loadingTemplates}>
            刷新列表
          </Button>
        }
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card title="请求">
            <Form layout="vertical" requiredMark="optional">
              <Form.Item label="注册名称">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="注册到中心的名称" />
              </Form.Item>
              <Row gutter={12}>
                <Col xs={24} sm={8}>
                  <Form.Item label="方法" required>
                    <Select
                      value={method}
                      options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => ({
                        value: m,
                        label: m,
                      }))}
                      onChange={setMethod}
                    />
                  </Form.Item>
                </Col>
                <Col xs={12} sm={8}>
                  <Form.Item label="超时毫秒" required>
                    <InputNumber
                      min={1}
                      value={timeoutMs ?? undefined}
                      onChange={(v) => setTimeoutMs(v)}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
                <Col xs={12} sm={8}>
                  <Form.Item label="期望状态码" required>
                    <InputNumber
                      min={100}
                      value={expectStatus ?? undefined}
                      onChange={(v) => setExpectStatus(v)}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item label="URL" required>
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." />
              </Form.Item>
              <Form.Item label="Headers">
                <JsonFieldHint>{'JSON object，例如 {"Authorization": "Bearer …"}'}</JsonFieldHint>
                <Input.TextArea
                  className="atlas-mono-textarea"
                  rows={4}
                  value={headers}
                  onChange={(e) => setHeaders(e.target.value)}
                />
              </Form.Item>
              <Form.Item label="Body">
                <Input.TextArea
                  className="atlas-mono-textarea"
                  rows={6}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="可选请求体"
                />
              </Form.Item>
              <Space>
                <Button type="primary" loading={busy} onClick={() => void run()}>
                  试跑
                </Button>
                <Button loading={busy} onClick={() => void register()}>
                  注册到中心
                </Button>
              </Space>
            </Form>
          </Card>
        </Col>

        <Col xs={24} xl={10}>
          <Card
            title="响应"
            extra={
              lastResponse?.status != null ? (
                <Tag color={lastResponse.ok ? 'success' : 'warning'}>HTTP {String(lastResponse.status)}</Tag>
              ) : null
            }
          >
            <JsonBlock value={responseText} emptyText="试跑响应将显示在这里" />
          </Card>
        </Col>
      </Row>

      <Card title="中心 REST 模板">
        <Table
          size="middle"
          rowKey={(row) => String(row.id ?? row.name)}
          loading={loadingTemplates}
          dataSource={templates}
          pagination={{ pageSize: 8, showSizeChanger: false }}
          locale={{ emptyText: '暂无 REST 模板' }}
          columns={[
            { title: 'ID', dataIndex: 'id', width: 72 },
            { title: '名称', dataIndex: 'name', ellipsis: true },
            {
              title: '方法',
              width: 90,
              render: (_, row) => (
                <Tag>{String(inputValue(row.inputs, 'method') || '—').toUpperCase()}</Tag>
              ),
            },
            { title: '来源机台', dataIndex: 'origin_agent_name', ellipsis: true },
            {
              title: '操作',
              width: 90,
              render: (_, row) => (
                <Button size="small" type="link" onClick={() => loadTemplate(row)}>
                  加载
                </Button>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
