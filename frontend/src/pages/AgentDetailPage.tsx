import { Alert, App, Button, Card, Descriptions, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { schedulerApi } from '../api/schedulerApi';
import { PageHeader } from '../components/PageHeader';
import { agentStatus, formatAgentHeartbeat, type Agent } from '../lib/agentTelemetry';
import { STATUS_LED } from '../theme';
import { formatPercent, statusLabel } from './MachinesPage';

const POLL_MS = 2000;
const MAX_POLL_MS = 30000;

function statusColor(agent: Agent): string {
  return STATUS_LED[agentStatus(agent)];
}

export function AgentDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pollIntervalMs, setPollIntervalMs] = useState(POLL_MS);
  const [lastRefreshAt, setLastRefreshAt] = useState<Date | null>(null);
  const [autoRefreshPaused, setAutoRefreshPaused] = useState(() => document.hidden);

  const load = useCallback(async (userInitiated = false) => {
    if (userInitiated) setLoading(true);
    try {
      const nextAgents = await schedulerApi.listAgents();
      setAgents(Array.isArray(nextAgents) ? nextAgents : []);
      setLastRefreshAt(new Date());
      setLoadError(null);
      setPollIntervalMs(POLL_MS);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (userInitiated) {
        message.error('加载机台失败：' + detail);
      } else {
        setLoadError(detail);
        setPollIntervalMs((current) => Math.min(current * 2, MAX_POLL_MS));
      }
    } finally {
      if (userInitiated) setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (!id) {
      navigate('/machines', { replace: true });
      return undefined;
    }

    void load(false);
    const intervalId = window.setInterval(() => {
      if (!document.hidden) void load(false);
    }, pollIntervalMs);
    const handleVisibilityChange = () => {
      const hidden = document.hidden;
      setAutoRefreshPaused(hidden);
      if (!hidden) void load(false);
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [id, load, navigate, pollIntervalMs]);

  const agent = useMemo(() => agents.find((item) => item.id === id), [agents, id]);

  useEffect(() => {
    if (lastRefreshAt && !loading && !agent) {
      navigate('/machines', { replace: true });
    }
  }, [agent, lastRefreshAt, loading, navigate]);

  const lastRefreshLabel = lastRefreshAt
    ? '最近刷新 · ' + lastRefreshAt.toLocaleTimeString('zh-CN')
    : '尚未刷新';

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <PageHeader
        title={agent?.name ?? '机台详情'}
        onBack={() => navigate('/machines')}
        extra={
          <Button onClick={() => void load(true)} loading={loading}>
            刷新
          </Button>
        }
      />

      {loadError ? (
        <Alert
          type="warning"
          showIcon
          message="自动刷新失败"
          description={`${loadError}（将每 ${Math.round(pollIntervalMs / 1000)} 秒重试）`}
          action={
            <Button size="small" onClick={() => void load(true)}>
              立即重试
            </Button>
          }
        />
      ) : null}

      <Space wrap>
        <Typography.Text type="secondary">{lastRefreshLabel}</Typography.Text>
        <Typography.Text type={autoRefreshPaused ? 'warning' : 'secondary'}>
          {autoRefreshPaused
            ? '自动刷新已暂停'
            : `自动刷新 · ${Math.round(pollIntervalMs / 1000)} 秒`}
        </Typography.Text>
      </Space>

      <Card
        className={agent ? 'atlas-station-card atlas-station-card--' + agentStatus(agent) : undefined}
        loading={loading && !agent}
      >
        {agent ? (
          <Descriptions bordered column={1}>
            <Descriptions.Item label="状态">
              <Tag color={statusColor(agent)}>{statusLabel(agent)}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="地址">
              <Typography.Text code>
                {agent.ip}:{agent.port}
              </Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="CPU">
              <Typography.Text code>{formatPercent(agent.cpu_percent)}</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="内存">
              <Typography.Text code>{formatPercent(agent.memory_percent)}</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="忙碌">{agent.busy ? '是' : '否'}</Descriptions.Item>
            <Descriptions.Item label="最后心跳">
              <Typography.Text code>{formatAgentHeartbeat(agent.last_seen_at)}</Typography.Text>
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Typography.Text type="secondary">加载中…</Typography.Text>
        )}
      </Card>
    </Space>
  );
}
