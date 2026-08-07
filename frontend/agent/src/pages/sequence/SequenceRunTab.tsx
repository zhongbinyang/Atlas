import {
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Progress,
  Row,
  Space,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { agentApi } from '../../api/agentApi';
import { ApiError } from '../../api/client';
import {
  buildActiveSequenceSummary,
  countRunQueueSteps,
  readActiveSequenceBinding,
} from './sequenceActive';
import {
  buildSequenceChannelCardModel,
  buildSequenceRunPayload,
  channelProgressFromEnvelope,
  type ChannelConfig,
  type ChannelProgress,
  type QueueItem,
  formatSequenceElapsed,
  formatSequenceOverall,
  mergeSequenceChannels,
  sequenceChannelsForDisplay,
  sequenceOverallFromChannels,
  sequenceRunQueueItems,
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
  if (state === 'pass') return 'success';
  if (state === 'fail') return 'error';
  return 'default';
};

export function SequenceRunTab() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [channels, setChannels] = useState<ChannelConfig[]>([]);
  const [selectedIndexes, setSelectedIndexes] = useState<number[] | null>(null);
  const [progress, setProgress] = useState<ChannelProgress[]>([]);
  const [pendingStarts, setPendingStarts] = useState<Record<number, boolean>>({});
  const [exclusiveBusy, setExclusiveBusy] = useState(false);
  const [stationOverall, setStationOverall] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);

  const runQueueCount = sequenceRunQueueItems(queue).length;
  const activeSummary = buildActiveSequenceSummary(
    countRunQueueSteps(queue),
    readActiveSequenceBinding(),
  );
  const enabledChannels = useMemo(
    () => channels.filter((ch) => ch.enabled !== false),
    [channels],
  );
  const displayChannels = useMemo(
    () => sequenceChannelsForDisplay(enabledChannels, selectedIndexes, progress),
    [enabledChannels, selectedIndexes, progress],
  );
  const anyRunning = progress.some((ch) => !!ch.running);
  const anyActivity = anyRunning || Object.keys(pendingStarts).length > 0;

  const stopPoll = useCallback(() => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const ensurePoll = useCallback(
    (nextProgress: ChannelProgress[], nextPending: Record<number, boolean>) => {
      if (shouldPollSequenceProgress(nextProgress, nextPending)) {
        if (pollRef.current == null) {
          pollRef.current = window.setInterval(() => {
            void refreshRef.current();
          }, 250);
        }
      } else {
        stopPoll();
      }
    },
    [stopPoll],
  );

  const refreshProgress = useCallback(async () => {
    try {
      const prog = asRecord(await agentApi.sequenceProgress());
      const incoming = channelProgressFromEnvelope(prog);
      setProgress((current) => {
        const merged = mergeSequenceChannels(current, incoming);
        setStationOverall(
          prog.running === true
            ? 'running'
            : sequenceOverallFromChannels(merged) ||
                (prog.overall != null ? String(prog.overall) : null),
        );
        setPendingStarts((pending) => {
          const nextPending = { ...pending };
          incoming.forEach((ch) => {
            if (ch.running || ch.overall) delete nextPending[ch.channel_index];
          });
          ensurePoll(merged, nextPending);
          return nextPending;
        });
        return merged;
      });
    } catch {
      /* best-effort */
    }
  }, [ensurePoll]);

  useEffect(() => {
    refreshRef.current = refreshProgress;
  }, [refreshProgress]);

  const loadBootstrap = useCallback(async () => {
    try {
      const [queueResp, channelsResp] = await Promise.all([
        agentApi.getRunQueue(),
        agentApi.getChannels().catch(() => ({ channels: [] })),
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
      await refreshProgress();
    } catch (error) {
      message.error(`加载序列运行页失败: ${getErrorMessage(error)}`);
    }
  }, [message, refreshProgress]);

  useEffect(() => {
    void loadBootstrap();
    return () => stopPoll();
  }, [loadBootstrap, stopPoll]);

  const selectableIndexes = useMemo(() => {
    if (!enabledChannels.length) return [0];
    return enabledChannels.map((ch) => ch.channel_index);
  }, [enabledChannels]);

  const topRunIndexes = (): number[] | null => {
    if (!enabledChannels.length) return null; // synthetic CH0: omit channel_indexes
    if (selectedIndexes == null) return null; // all enabled
    if (!selectedIndexes.length) return [];
    if (selectedIndexes.length === selectableIndexes.length) return null;
    return selectedIndexes.slice();
  };

  const isChannelActive = (index: number) =>
    progress.some((ch) => Number(ch.channel_index) === index && !!ch.running) ||
    !!pendingStarts[index];

  const runSequence = async (explicitIndexes?: number[] | null, synthetic?: boolean) => {
    if (!runQueueCount) {
      message.error('执行队列为空');
      return;
    }
    const indexes =
      explicitIndexes !== undefined ? explicitIndexes : topRunIndexes();
    if (Array.isArray(indexes) && indexes.length === 0) {
      message.error('请至少选择一个通道');
      return;
    }
    const targets =
      Array.isArray(indexes) && indexes.length
        ? indexes
        : synthetic || !enabledChannels.length
          ? [0]
          : selectableIndexes.filter((index) => !isChannelActive(index));
    if (!targets.length && explicitIndexes === undefined) {
      message.warning('所选通道均在运行中');
      return;
    }

    setExclusiveBusy(true);
    setPendingStarts((prev) => {
      const next = { ...prev };
      (Array.isArray(indexes) ? indexes : targets).forEach((index) => {
        next[Number(index)] = true;
      });
      return next;
    });
    try {
      const payload = buildSequenceRunPayload(
        readActiveSequenceBinding()?.id ?? null,
        selectedIndexes,
        explicitIndexes === undefined
          ? topRunIndexes()
          : synthetic
            ? null
            : explicitIndexes,
      );
      // For synthetic CH0, omit channel_indexes (null explicit → no field via build with null selected)
      if (synthetic || (!enabledChannels.length && explicitIndexes == null)) {
        delete payload.channel_indexes;
      }
      await agentApi.sequenceRun(payload);
      message.success('已开始执行');
      await refreshProgress();
    } catch (error) {
      message.error(`执行失败: ${getErrorMessage(error)}`);
      setPendingStarts((prev) => {
        const next = { ...prev };
        (Array.isArray(indexes) ? indexes : targets).forEach((index) => {
          delete next[Number(index)];
        });
        return next;
      });
      await refreshProgress();
    } finally {
      setExclusiveBusy(false);
    }
  };

  const abortAll = async () => {
    setExclusiveBusy(true);
    try {
      await agentApi.sequenceAbort();
      message.success('已请求全部中止');
      await refreshProgress();
    } catch (error) {
      message.error(`中止失败: ${getErrorMessage(error)}`);
    } finally {
      setExclusiveBusy(false);
    }
  };

  const abortChannel = async (index: number) => {
    setExclusiveBusy(true);
    try {
      await agentApi.sequenceAbortChannel(index);
      message.success(`已请求中止 CH${index}`);
      await refreshProgress();
    } catch (error) {
      message.error(`中止通道失败: ${getErrorMessage(error)}`);
    } finally {
      setExclusiveBusy(false);
    }
  };

  const openChannelDetail = (index: number) => {
    navigate(`/sequence/channels/${index}`);
  };

  const hasInactiveSelected = (() => {
    const selected = topRunIndexes();
    const selectable = Array.isArray(selected) ? selected : selectableIndexes;
    if (!selectable.length) return true;
    return selectable.some((index) => !isChannelActive(index));
  })();

  return (
    <div className="atlas-page" style={{ gap: 12 }}>
      <div>
        <Space wrap size="middle">
          <Typography.Text strong>{activeSummary.title}</Typography.Text>
          {activeSummary.dirty ? <Tag color="warning">已改动</Tag> : null}
        </Space>
        <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 13 }}>
          运行的是编排页「执行顺序」中的当前队列；模板绑定仅用于展示与日志。点击通道卡片或「详情」进入独立详情页。
        </Typography.Paragraph>
      </div>
      <Card size="small">
        <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space wrap size="middle">
            <Typography.Text type="secondary">
              队列 <Typography.Text strong>{runQueueCount}</Typography.Text> 步
            </Typography.Text>
            <span>
              总体{' '}
              <Tag color={statusColor(stationOverall === 'running' ? 'running' : stationOverall || 'idle')}>
                {formatSequenceOverall(stationOverall)}
              </Tag>
            </span>
            {enabledChannels.length ? (
              <Checkbox.Group
                options={enabledChannels.map((ch) => ({
                  label: ch.name || `CH${ch.channel_index}`,
                  value: ch.channel_index,
                }))}
                value={selectedIndexes == null ? selectableIndexes : selectedIndexes}
                onChange={(values) => {
                  const next = values.map(Number);
                  if (next.length === selectableIndexes.length) setSelectedIndexes(null);
                  else setSelectedIndexes(next);
                }}
                disabled={anyActivity}
              />
            ) : (
              <Typography.Text type="secondary">通道：CH0（合成）</Typography.Text>
            )}
          </Space>
          <Space wrap>
            <Button
              type="primary"
              loading={exclusiveBusy}
              disabled={!runQueueCount || exclusiveBusy || !hasInactiveSelected}
              onClick={() => void runSequence()}
            >
              开始执行
            </Button>
            <Button danger loading={exclusiveBusy} disabled={!anyRunning} onClick={() => void abortAll()}>
              全部中止
            </Button>
            <Button onClick={() => void refreshProgress()}>刷新进度</Button>
          </Space>
        </Space>
      </Card>

      {!displayChannels.length ? (
        <Typography.Paragraph type="secondary">请至少选择一个运行通道。</Typography.Paragraph>
      ) : (
        <Row gutter={[16, 16]}>
          {displayChannels.map((channel) => {
            const model = buildSequenceChannelCardModel(channel, queue);
            const percent = model.total ? Math.min(100, Math.round((model.completed / model.total) * 100)) : 0;
            const name = channel.name || `CH${channel.channel_index}`;
            const statusText = model.state === 'idle' ? '待开始' : formatSequenceOverall(model.state);
            const active = isChannelActive(channel.channel_index);
            return (
              <Col key={channel.channel_index} xs={24} sm={12} lg={8} xl={6}>
                <Card
                  size="small"
                  className={`atlas-channel-card${active ? ' is-active' : ''}`}
                  title={
                    <Space>
                      <Typography.Text strong>{name}</Typography.Text>
                      <Tag color={statusColor(model.state)}>{statusText}</Tag>
                    </Space>
                  }
                  actions={[
                    <Button
                      key="run"
                      type="link"
                      disabled={!runQueueCount || exclusiveBusy || active}
                      onClick={(event) => {
                        event.stopPropagation();
                        void runSequence(
                          channel.synthetic ? null : [channel.channel_index],
                          channel.synthetic === true,
                        );
                      }}
                    >
                      运行
                    </Button>,
                    <Button
                      key="abort"
                      type="link"
                      danger
                      disabled={!channel.running || exclusiveBusy}
                      onClick={(event) => {
                        event.stopPropagation();
                        void abortChannel(channel.channel_index);
                      }}
                    >
                      中止
                    </Button>,
                    <Button
                      key="detail"
                      type="link"
                      onClick={(event) => {
                        event.stopPropagation();
                        openChannelDetail(channel.channel_index);
                      }}
                    >
                      详情
                    </Button>,
                  ]}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => openChannelDetail(channel.channel_index)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openChannelDetail(channel.channel_index);
                      }
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <Typography.Text type="secondary">
                      {model.completed} / {model.total} 步完成
                    </Typography.Text>
                    <div style={{ marginTop: 8 }}>
                      <Typography.Text type="secondary">当前组 </Typography.Text>
                      <Typography.Text strong>{model.currentGroupName}</Typography.Text>
                    </div>
                    <div>
                      <Typography.Text type="secondary">{model.currentLabel} </Typography.Text>
                      <Typography.Text strong>{model.currentName}</Typography.Text>
                      <Typography.Text code style={{ marginLeft: 8 }}>
                        {model.currentElapsedMs == null ? '—' : formatSequenceElapsed(model.currentElapsedMs)}
                      </Typography.Text>
                    </div>
                    <Progress percent={percent} size="small" style={{ marginTop: 8 }} />
                    <Space wrap style={{ marginTop: 8 }}>
                      <span>
                        通过 <strong>{model.passed}</strong>
                      </span>
                      <span>
                        失败 <strong>{model.failed}</strong>
                      </span>
                      <span>
                        跳过 <strong>{model.skipped}</strong>
                      </span>
                      <span>
                        总耗时 <Typography.Text code>{formatSequenceElapsed(model.elapsedMs)}</Typography.Text>
                      </span>
                    </Space>
                  </div>
                </Card>
              </Col>
            );
          })}
        </Row>
      )}
    </div>
  );
}
