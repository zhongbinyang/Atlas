import { App, Button, Card, Space, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { agentApi } from '../../api/agentApi';
import { ApiError } from '../../api/client';

const getErrorMessage = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : String(error);

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function SequenceRunTab() {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const [progressText, setProgressText] = useState('尚未开始');
  const [rawProgress, setRawProgress] = useState('');
  const timerRef = useRef<number | null>(null);

  const stopPoll = () => {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const refreshProgress = useCallback(async () => {
    try {
      const data = asRecord(await agentApi.sequenceProgress());
      setRawProgress(JSON.stringify(data, null, 2));
      const overall = data.overall != null ? String(data.overall) : '—';
      const running = data.running === true || data.active === true;
      setProgressText(running ? `运行中 · 总体：${overall}` : `空闲 · 总体：${overall}`);
      if (!running) stopPoll();
    } catch (error) {
      setProgressText(`进度刷新失败: ${getErrorMessage(error)}`);
    }
  }, []);

  useEffect(() => {
    void refreshProgress();
    return () => stopPoll();
  }, [refreshProgress]);

  const startPoll = () => {
    stopPoll();
    timerRef.current = window.setInterval(() => {
      void refreshProgress();
    }, 1000);
  };

  const run = async () => {
    setBusy(true);
    try {
      const data = asRecord(await agentApi.sequenceRun({}));
      setRawProgress(JSON.stringify(data, null, 2));
      message.success('已开始执行');
      startPoll();
      await refreshProgress();
    } catch (error) {
      message.error(`执行失败: ${getErrorMessage(error)}`);
      await refreshProgress();
    } finally {
      setBusy(false);
    }
  };

  const abort = async () => {
    setBusy(true);
    try {
      await agentApi.sequenceAbort();
      message.success('已请求中止');
      await refreshProgress();
    } catch (error) {
      message.error(`中止失败: ${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        序列运行
      </Typography.Title>
      <Card>
        <Space>
          <Button type="primary" loading={busy} onClick={() => void run()}>
            开始执行
          </Button>
          <Button danger loading={busy} onClick={() => void abort()}>
            全部中止
          </Button>
          <Button onClick={() => void refreshProgress()}>刷新进度</Button>
        </Space>
        <Typography.Paragraph style={{ marginTop: 16 }}>{progressText}</Typography.Paragraph>
        {rawProgress ? <pre>{rawProgress}</pre> : null}
      </Card>
    </Space>
  );
}
