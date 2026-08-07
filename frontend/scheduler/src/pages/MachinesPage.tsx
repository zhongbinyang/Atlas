import {
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Statistic,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { schedulerApi } from '../api/schedulerApi';
import {
  agentStatus,
  getAgentTelemetry,
  type Agent,
  type TelemetryFilters,
} from '../lib/agentTelemetry';

const POLL_MS = 2000;

const statusOptions: Array<{ label: string; value: TelemetryFilters['status'] }> = [
  { label: '全部', value: 'all' },
  { label: '在线', value: 'online' },
  { label: '忙碌', value: 'busy' },
  { label: '离线', value: 'offline' },
];

const sortOptions: Array<{ label: string; value: TelemetryFilters['sort'] }> = [
  { label: '名称', value: 'name' },
  { label: '状态', value: 'status' },
  { label: 'CPU', value: 'cpu_desc' },
  { label: '内存', value: 'memory_desc' },
];

export function statusLabel(agent: Agent): string {
  if (agent.status === 'offline') return '离线';
  return agent.busy ? '在线·忙碌' : '在线·空闲';
}

export function formatPercent(value: number): string {
  return Number(value || 0).toFixed(1) + '%';
}

function statusColor(agent: Agent): string {
  const status = agentStatus(agent);
  if (status === 'offline') return 'red';
  if (status === 'busy') return 'gold';
  return 'green';
}

export function MachinesPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState<Date | null>(null);
  const [autoRefreshPaused, setAutoRefreshPaused] = useState(() => document.hidden);
  const [filters, setFilters] = useState<TelemetryFilters>({
    query: '',
    status: 'all',
    sort: 'name',
    abnormalOnly: false,
  });

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
  }, [load]);

  const telemetry = useMemo(() => getAgentTelemetry(agents, filters), [agents, filters]);
  const lastRefreshLabel = lastRefreshAt
    ? '最近刷新 · ' + lastRefreshAt.toLocaleTimeString('zh-CN')
    : '尚未刷新';
  const emptyText = agents.length === 0 ? '暂无机台' : '没有匹配机台';

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          机台
        </Typography.Title>
        <Button onClick={() => void load()} loading={loading}>
          刷新
        </Button>
      </Space>

      <Card>
        <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
          <Row gutter={[16, 16]}>
            <Col xs={12} md={6}>
              <Statistic title="总数" value={telemetry.summary.total} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title="在线" value={telemetry.summary.online} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title="忙碌" value={telemetry.summary.busy} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title="离线" value={telemetry.summary.offline} />
            </Col>
          </Row>

          <Space wrap>
            <Typography.Text type="secondary">{lastRefreshLabel}</Typography.Text>
            <Typography.Text type={autoRefreshPaused ? 'warning' : 'secondary'}>
              {autoRefreshPaused ? '自动刷新已暂停' : '自动刷新 · 2 秒'}
            </Typography.Text>
          </Space>

          <Space wrap align="center">
            <Typography.Text>搜索</Typography.Text>
            <Input
              id="agent-search"
              name="agent-search"
              type="search"
              allowClear
              placeholder="名称、IP 或端口"
              value={filters.query}
              onChange={(event) =>
                setFilters((current) => ({ ...current, query: event.target.value }))
              }
              style={{ width: 220 }}
            />
            <Typography.Text>状态</Typography.Text>
            <Select
              id="agent-status-filter"
              value={filters.status}
              onChange={(status) => setFilters((current) => ({ ...current, status }))}
              options={statusOptions}
              style={{ width: 120 }}
            />
            <Typography.Text>排序</Typography.Text>
            <Select
              id="agent-sort"
              value={filters.sort}
              onChange={(sort) => setFilters((current) => ({ ...current, sort }))}
              options={sortOptions}
              style={{ width: 120 }}
            />
            <Checkbox
              name="agent-abnormal-only"
              checked={filters.abnormalOnly}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  abnormalOnly: event.target.checked,
                }))
              }
            >
              仅异常
            </Checkbox>
          </Space>
        </Space>
      </Card>

      {loading && !lastRefreshAt ? (
        <Card loading />
      ) : telemetry.visibleAgents.length === 0 ? (
        <Empty description={emptyText} />
      ) : (
        <Row gutter={[16, 16]} aria-live="polite">
          {telemetry.visibleAgents.map((agent) => (
            <Col key={agent.id} xs={24} sm={12} lg={8} xl={6}>
              <Card
                hoverable
                role="button"
                tabIndex={0}
                onClick={() => navigate('/agents/' + encodeURIComponent(agent.id))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    navigate('/agents/' + encodeURIComponent(agent.id));
                  }
                }}
              >
                <Space direction="vertical" size="small" style={{ display: 'flex' }}>
                  <Typography.Text strong>{agent.name}</Typography.Text>
                  <Typography.Text type="secondary" code>
                    {agent.ip}:{agent.port}
                  </Typography.Text>
                  <Tag color={statusColor(agent)}>{statusLabel(agent)}</Tag>
                  <Space>
                    <Typography.Text>CPU {formatPercent(agent.cpu_percent)}</Typography.Text>
                    <Typography.Text>内存 {formatPercent(agent.memory_percent)}</Typography.Text>
                  </Space>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      )}
    </Space>
  );
}
