import { App, Button, Card, Descriptions, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { schedulerApi } from '../api/schedulerApi';
import { agentStatus, formatAgentHeartbeat, type Agent } from '../lib/agentTelemetry';
import { formatPercent, statusLabel } from './MachinesPage';

const POLL_MS = 2000;

function statusColor(agent: Agent): string {
  const status = agentStatus(agent);
  if (status === 'offline') return 'red';
  if (status === 'busy') return 'gold';
  return 'green';
}

export function AgentDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState<Date | null>(null);
  const [autoRefreshPaused, setAutoRefreshPaused] = useState(() => document.hidden);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const nextAgents = await schedulerApi.listAgents();
      setAgents(Array.isArray(nextAgents) ? nextAgents : []);
      setLastRefreshAt(new Date());
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      message.error('加载机台失败：' + detail);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (!id) {
      navigate('/machines', { replace: true });
      return undefined;
    }

    void load();
    const intervalId = window.setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    const handleVisibilityChange = () => {
      const hidden = document.hidden;
      setAutoRefreshPaused(hidden);
      if (!hidden) void load();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [id, load, navigate]);

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
      <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space>
          <Button onClick={() => navigate('/machines')}>返回机台</Button>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {agent?.name ?? '机台详情'}
          </Typography.Title>
        </Space>
        <Button onClick={() => void load()} loading={loading}>
          刷新
        </Button>
      </Space>

      <Space wrap>
        <Typography.Text type="secondary">{lastRefreshLabel}</Typography.Text>
        <Typography.Text type={autoRefreshPaused ? 'warning' : 'secondary'}>
          {autoRefreshPaused ? '自动刷新已暂停' : '自动刷新 · 2 秒'}
        </Typography.Text>
      </Space>

      <Card loading={loading && !agent}>
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
