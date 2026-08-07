import { App, Button, Card, Space, Table, Tabs, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { agentApi } from '../../api/agentApi';
import { ApiError } from '../../api/client';
import { JsonBlock } from '../../components/JsonBlock';
import { PageHeader } from '../../components/PageHeader';
import {
  buildChannelLogText,
  buildDetailStepRows,
  collectMeasuredKeys,
  type DetailStepRow,
} from './sequenceDetailModels';
import {
  buildActiveSequenceSummary,
  countRunQueueSteps,
  readActiveSequenceBinding,
} from './sequenceActive';
import {
  channelProgressFromEnvelope,
  type ChannelProgress,
  type QueueItem,
  formatSequenceElapsed,
  formatSequenceOverall,
  mergeSequenceChannels,
  sequenceChannelsForDisplay,
  shouldPollSequenceProgress,
} from './sequenceRunModels';

const getErrorMessage = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : String(error);

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const statusColor = (state: string) => {
  if (state === 'running') return 'processing';
  if (state === 'pass' || state === 'ok') return 'success';
  if (state === 'fail' || state === 'failed' || state === 'error' || state === 'aborted') return 'error';
  return 'default';
};

export function SequenceChannelDetailPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const params = useParams();
  const channelIndex = Number(params.channelIndex);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [channels, setChannels] = useState<Array<{ channel_index: number; name?: string; enabled?: boolean }>>(
    [],
  );
  const [progress, setProgress] = useState<ChannelProgress[]>([]);
  const [logDir, setLogDir] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<number | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);

  const enabledChannels = useMemo(
    () => channels.filter((ch) => ch.enabled !== false),
    [channels],
  );
  const displayChannels = useMemo(
    () => sequenceChannelsForDisplay(enabledChannels, null, progress),
    [enabledChannels, progress],
  );
  const channel =
    displayChannels.find((ch) => Number(ch.channel_index) === channelIndex) || null;
  const rows = useMemo(
    () => (channel ? buildDetailStepRows(channel, queue) : []),
    [channel, queue],
  );
  const measuredKeys = useMemo(() => collectMeasuredKeys(rows), [rows]);
  const logText = useMemo(
    () => (channel ? buildChannelLogText(channel, rows, logDir) : ''),
    [channel, rows, logDir],
  );
  const activeSummary = buildActiveSequenceSummary(
    countRunQueueSteps(queue),
    readActiveSequenceBinding(),
  );
  const channelPos = displayChannels.findIndex((ch) => Number(ch.channel_index) === channelIndex);

  const stopPoll = useCallback(() => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const refreshProgress = useCallback(async () => {
    try {
      const prog = asRecord(await agentApi.sequenceProgress());
      const incoming = channelProgressFromEnvelope(prog);
      setProgress((current) => {
        const merged = mergeSequenceChannels(current, incoming);
        if (shouldPollSequenceProgress(merged, {})) {
          if (pollRef.current == null) {
            pollRef.current = window.setInterval(() => {
              void refreshRef.current();
            }, 250);
          }
        } else {
          stopPoll();
        }
        return merged;
      });
    } catch {
      /* best-effort */
    }
  }, [stopPoll]);

  useEffect(() => {
    refreshRef.current = refreshProgress;
  }, [refreshProgress]);

  const loadBootstrap = useCallback(async () => {
    setLoading(true);
    try {
      const [queueResp, channelsResp, statusResp] = await Promise.all([
        agentApi.getRunQueue(),
        agentApi.getChannels().catch(() => ({ channels: [] })),
        agentApi.status().catch(() => null),
      ]);
      const queueData = asRecord(queueResp);
      setQueue(Array.isArray(queueData.items) ? (queueData.items as QueueItem[]) : []);
      const channelData = asRecord(channelsResp);
      const list = Array.isArray(channelData.channels) ? channelData.channels : [];
      setChannels(
        list.map((item) => {
          const ch = asRecord(item);
          return {
            channel_index: Number(ch.channel_index) || 0,
            name: String(ch.name ?? `CH${Number(ch.channel_index) || 0}`),
            enabled: ch.enabled !== false,
          };
        }),
      );
      if (statusResp && typeof statusResp === 'object') {
        const status = statusResp as { log_dir?: string };
        setLogDir(status.log_dir ? String(status.log_dir) : null);
      }
      await refreshProgress();
    } catch (error) {
      message.error(`加载通道详情失败: ${getErrorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, [message, refreshProgress]);

  useEffect(() => {
    void loadBootstrap();
    return () => stopPoll();
  }, [loadBootstrap, stopPoll]);

  const testColumns: ColumnsType<DetailStepRow> = useMemo(() => {
    const base: ColumnsType<DetailStepRow> = [
      {
        title: '#',
        width: 56,
        fixed: 'left',
        render: (_, row) => String(row.position + 1).padStart(2, '0'),
      },
      {
        title: '组名',
        dataIndex: 'groupName',
        width: 120,
        fixed: 'left',
        ellipsis: true,
        render: (value: string) => value || '---',
      },
      {
        title: '测试项',
        dataIndex: 'name',
        fixed: 'left',
        width: 180,
        ellipsis: true,
      },
      {
        title: '来源',
        dataIndex: 'sourceLabel',
        width: 72,
        render: (value: string) => value || '---',
      },
      {
        title: '类型',
        dataIndex: 'kind',
        width: 100,
        ellipsis: true,
        render: (value: string) => value || '---',
      },
      {
        title: '状态',
        width: 90,
        render: (_, row) => {
          const text = row.status === 'pending' ? '待执行' : formatSequenceOverall(row.status);
          return <Tag color={statusColor(row.status)}>{text}</Tag>;
        },
      },
      {
        title: '判定',
        width: 72,
        render: (_, row) =>
          row.ok == null ? '—' : row.ok ? <Tag color="success">OK</Tag> : <Tag color="error">NG</Tag>,
      },
      {
        title: '耗时',
        width: 110,
        render: (_, row) =>
          row.status === 'running' && channel?.current_step_elapsed_ms != null
            ? formatSequenceElapsed(channel.current_step_elapsed_ms)
            : formatSequenceElapsed(row.elapsedMs),
      },
    ];
    const measuredCols: ColumnsType<DetailStepRow> = measuredKeys.map((key) => ({
      title: key,
      width: Math.min(160, Math.max(96, key.length * 10)),
      ellipsis: true,
      render: (_, row) => {
        const value = row.measured[key];
        return value == null ? '—' : String(value);
      },
    }));
    return [
      ...base,
      ...measuredCols,
      {
        title: 'Spec',
        dataIndex: 'limitsSummary',
        width: 200,
        ellipsis: true,
      },
      {
        title: '错误',
        dataIndex: 'error',
        width: 160,
        ellipsis: true,
        render: (value: string) => value || '—',
      },
      {
        title: '结果 JSON',
        dataIndex: 'resultJson',
        width: 220,
        ellipsis: true,
        render: (value: string) => value || '—',
      },
    ];
  }, [measuredKeys, channel]);

  return (
    <div className="atlas-page">
      <PageHeader
        title={channel ? `${channel.name || `CH${channel.channel_index}`} 详情` : '通道详情'}
        description={`${activeSummary.title} · 独立详情页（测试项 / 日志），后续可按反馈调优列与布局。`}
        extra={
          <Space wrap>
            <Button onClick={() => navigate('/sequence', { state: { tab: 'run' } })}>返回运行</Button>
            <Button
              disabled={channelPos <= 0}
              onClick={() => {
                if (channelPos > 0) {
                  navigate(`/sequence/channels/${displayChannels[channelPos - 1].channel_index}`);
                }
              }}
            >
              上一通道
            </Button>
            <Button
              disabled={channelPos < 0 || channelPos >= displayChannels.length - 1}
              onClick={() => {
                if (channelPos >= 0 && channelPos < displayChannels.length - 1) {
                  navigate(`/sequence/channels/${displayChannels[channelPos + 1].channel_index}`);
                }
              }}
            >
              下一通道
            </Button>
            <Button loading={loading} onClick={() => void loadBootstrap()}>
              刷新
            </Button>
          </Space>
        }
      />

      {!Number.isFinite(channelIndex) ? (
        <Typography.Text type="danger">无效通道索引</Typography.Text>
      ) : !channel ? (
        <Card loading={loading}>
          <Typography.Text type="secondary">
            未找到通道 CH{channelIndex}。请从{' '}
            <Link to="/sequence">序列运行</Link> 重新进入。
          </Typography.Text>
        </Card>
      ) : (
        <>
          <Card size="small">
            <Space wrap size="middle">
              <Tag color={statusColor(channel.running ? 'running' : String(channel.overall || 'idle'))}>
                {formatSequenceOverall(channel.running ? 'running' : channel.overall)}
              </Tag>
              <Typography.Text>
                总耗时 <Typography.Text code>{formatSequenceElapsed(channel.elapsed_ms)}</Typography.Text>
              </Typography.Text>
              <Typography.Text type="secondary">
                测试项 {rows.length} · 测量列 {measuredKeys.length}
              </Typography.Text>
              {channel.current_name ? (
                <Typography.Text type="secondary">
                  当前 {channel.current_name}
                  {channel.current_step_elapsed_ms != null
                    ? ` · ${formatSequenceElapsed(channel.current_step_elapsed_ms)}`
                    : ''}
                </Typography.Text>
              ) : null}
            </Space>
          </Card>

          <Tabs
            type="card"
            defaultActiveKey="tests"
            items={[
              {
                key: 'tests',
                label: '测试项',
                children: (
                  <Card>
                    <Table
                      size="small"
                      loading={loading}
                      rowKey={(row) => String(row.position)}
                      dataSource={rows}
                      pagination={false}
                      scroll={{ x: Math.max(960, 700 + measuredKeys.length * 120) }}
                      locale={{ emptyText: '暂无测试项（队列为空或尚未产生进度）' }}
                      columns={testColumns}
                    />
                  </Card>
                ),
              },
              {
                key: 'logs',
                label: '日志',
                children: (
                  <Card>
                    <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
                      当前从进度接口拼装运行日志；磁盘完整日志位于 Agent{' '}
                      <Typography.Text code>log_dir\sequence_runs</Typography.Text>
                      。
                    </Typography.Paragraph>
                    <JsonBlock value={logText} emptyText="暂无日志" maxHeight={560} />
                  </Card>
                ),
              },
            ]}
          />
        </>
      )}
    </div>
  );
}
