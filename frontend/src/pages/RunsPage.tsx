import {
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Input,
  Select,
  Space,
  Spin,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { schedulerApi } from '../api/schedulerApi';
import type { Agent, TestRunDetail, TestRunListItem, TestRunStep } from '../api/types';
import { PageHeader } from '../components/PageHeader';
import { describeApiError } from '../lib/formatError';
import { DEFAULT_TABLE_PAGINATION, EDITOR_TABLE_PAGINATION, formatTimestamp } from '../utils/tableHelpers';
import { agentLabel, displayOptional } from './runs/runDisplay';

const OVERALL_OPTIONS = [
  { label: 'pass', value: 'pass' },
  { label: 'fail', value: 'fail' },
  { label: 'error', value: 'error' },
  { label: 'aborted', value: 'aborted' },
];

function formatJsonCell(value: unknown): string {
  return JSON.stringify(value);
}

function formatElapsed(ms: number): string {
  return `${ms} ms`;
}

function RunList() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [items, setItems] = useState<TestRunListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [agentId, setAgentId] = useState<string | undefined>(undefined);
  const [overall, setOverall] = useState<string | undefined>(undefined);
  const [sn, setSn] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    void schedulerApi.listAgents().then((next) => {
      setAgents(Array.isArray(next) ? next : []);
    }).catch((error) => {
      message.error('加载机台失败：' + describeApiError(error));
    });
  }, [message]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void schedulerApi
      .listTestRuns({
        agent_id: agentId,
        overall,
        sn,
      })
      .then((page) => {
        if (!cancelled) {
          setItems(Array.isArray(page?.items) ? page.items : []);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setItems([]);
          message.error('加载运行失败：' + describeApiError(error));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, message, overall, sn, reloadToken]);

  const columns = useMemo<ColumnsType<TestRunListItem>>(
    () => [
      {
        title: '结束时间',
        dataIndex: 'finished_at',
        render: (value) => formatTimestamp(value),
      },
      {
        title: '机台',
        render: (_, record) => agentLabel(record.agent_id, agents, record.hostname),
      },
      {
        title: '通道',
        dataIndex: 'channel_name',
      },
      {
        title: '总结果',
        dataIndex: 'overall',
      },
      {
        title: 'SN',
        dataIndex: 'sn',
        render: (value) => displayOptional(value),
      },
      {
        title: '耗时',
        dataIndex: 'elapsed_ms',
        render: (value) => formatElapsed(Number(value || 0)),
      },
      {
        title: '操作',
        width: 80,
        fixed: 'right',
        render: (_, record) => (
          <Button size="small" type="link" onClick={() => navigate(`/runs/${record.id}`)}>
            查看
          </Button>
        ),
      },
    ],
    [agents, navigate],
  );

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <PageHeader
        title="运行"
        description="各机台已完成的测试运行记录。"
        extra={
          <Button onClick={() => setReloadToken((token) => token + 1)} loading={loading}>
            刷新
          </Button>
        }
      />

      <Card>
        <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
          <Space wrap>
            <Typography.Text>机台</Typography.Text>
            <Select
              allowClear
              placeholder="全部"
              value={agentId}
              onChange={(value) => setAgentId(value || undefined)}
              options={agents.map((agent) => ({
                label: agent.name || agent.id,
                value: agent.id,
              }))}
              style={{ width: 220 }}
            />
            <Typography.Text>总结果</Typography.Text>
            <Select
              allowClear
              placeholder="全部"
              value={overall}
              onChange={(value) => setOverall(value || undefined)}
              options={OVERALL_OPTIONS}
              style={{ width: 140 }}
            />
            <Typography.Text>SN</Typography.Text>
            <Input
              allowClear
              placeholder="SN"
              value={sn}
              onChange={(event) => setSn(event.target.value)}
              style={{ width: 180 }}
            />
          </Space>
          <Table
            rowKey={(record) => record.id}
            columns={columns}
            dataSource={items}
            loading={loading}
            locale={{ emptyText: '暂无运行记录' }}
            pagination={DEFAULT_TABLE_PAGINATION}
            scroll={{ x: true }}
          />
        </Space>
      </Card>
    </Space>
  );
}

function RunDetail({ id }: { id: string }) {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<TestRunDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void schedulerApi
      .getTestRun(id)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((error) => {
        if (!cancelled) {
          setDetail(null);
          message.error('加载运行详情失败：' + describeApiError(error));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, message]);

  const columns = useMemo<ColumnsType<TestRunStep>>(
    () => [
      { title: '步骤', dataIndex: 'name' },
      { title: '状态', dataIndex: 'status' },
      {
        title: '实测',
        dataIndex: 'measured',
        render: (value) => formatJsonCell(value),
      },
      {
        title: '限值',
        dataIndex: 'limits',
        render: (value) => formatJsonCell(value),
      },
      {
        title: '耗时',
        dataIndex: 'elapsed_ms',
        render: (value) => formatElapsed(Number(value || 0)),
      },
      {
        title: '错误',
        dataIndex: 'error',
        render: (value) => displayOptional(value),
      },
    ],
    [],
  );

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <PageHeader title="运行详情" onBack={() => navigate('/runs')} />

      <Card>
        {loading && !detail ? (
          <Spin />
        ) : detail ? (
          <Descriptions bordered column={2}>
            <Descriptions.Item label="通道">{detail.channel_name}</Descriptions.Item>
            <Descriptions.Item label="总结果">{detail.overall}</Descriptions.Item>
            <Descriptions.Item label="开始时间">{formatTimestamp(detail.started_at)}</Descriptions.Item>
            <Descriptions.Item label="结束时间">{formatTimestamp(detail.finished_at)}</Descriptions.Item>
            <Descriptions.Item label="SN">{displayOptional(detail.context?.sn)}</Descriptions.Item>
            <Descriptions.Item label="工单">{displayOptional(detail.context?.work_order)}</Descriptions.Item>
          </Descriptions>
        ) : (
          <Typography.Text type="secondary">未找到该运行</Typography.Text>
        )}
      </Card>

      <Card title="步骤">
        <Table
          rowKey={(record) => `${record.position}-${record.queue_item_id}`}
          columns={columns}
          dataSource={detail?.steps ?? []}
          loading={loading}
          locale={{ emptyText: '暂无步骤' }}
          pagination={EDITOR_TABLE_PAGINATION}
          scroll={{ x: true }}
        />
      </Card>
    </Space>
  );
}

export function RunsPage() {
  const { id } = useParams();
  if (id) {
    return <RunDetail id={id} />;
  }
  return <RunList />;
}
