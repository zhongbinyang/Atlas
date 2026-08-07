import { App as AntdApp, Button, Descriptions, Popover, Space, Spin, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { agentApi } from '../api/agentApi';
import type { AgentStatus } from '../api/types';

const POLL_MS = 2000;

function formatPercent(value: number | undefined) {
  return typeof value === 'number' ? `${value.toFixed(1)}%` : '-';
}

function formatUptime(totalSeconds: number | undefined) {
  if (typeof totalSeconds !== 'number') return '-';
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (days > 0) return `${days}天 ${hours}小时 ${minutes}分`;
  if (hours > 0) return `${hours}小时 ${minutes}分`;
  if (minutes > 0) return `${minutes}分 ${seconds}秒`;
  return `${seconds}秒`;
}

export function MachineInfoPopover() {
  const { message, modal } = AntdApp.useApp();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [releasing, setReleasing] = useState(false);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await agentApi.status());
    } catch (error) {
      message.error(`机台信息刷新失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (!open) return;
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, refreshStatus]);

  const handleForceRelease = () => {
    modal.confirm({
      title: '确认强制释放机台占用？',
      content: '若仍有 LabVIEW/请求在跑，可能留下未结束的进程。',
      okText: '强制释放',
      okButtonProps: { danger: true },
      cancelText: '取消',
      async onOk() {
        setReleasing(true);
        try {
          await agentApi.forceRelease();
          message.success('已强制释放占用');
          await refreshStatus();
        } catch (error) {
          message.error(`强制释放失败: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          setReleasing(false);
        }
      },
    });
  };

  const busyTag = status?.busy ? (
    <Tag color="processing">● 执行中</Tag>
  ) : (
    <Tag color="success">● 空闲</Tag>
  );

  const content = (
    <Spin spinning={loading && !status}>
      <Space direction="vertical" size="middle" style={{ minWidth: 280 }}>
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="主机名">{status?.hostname || '-'}</Descriptions.Item>
          <Descriptions.Item label="IP">{status?.ip || '-'}</Descriptions.Item>
          <Descriptions.Item label="运行时间">{formatUptime(status?.uptime_secs)}</Descriptions.Item>
          <Descriptions.Item label="CPU">{formatPercent(status?.cpu_percent)}</Descriptions.Item>
          <Descriptions.Item label="内存">{formatPercent(status?.memory_percent)}</Descriptions.Item>
          <Descriptions.Item label="状态">{busyTag}</Descriptions.Item>
        </Descriptions>
        {status?.busy ? (
          <Space direction="vertical" size="small">
            <Typography.Text type="secondary">
              {status.busy_message || '机台忙碌'}
            </Typography.Text>
            {status.can_force_release ? (
              <Button danger size="small" loading={releasing} onClick={handleForceRelease}>
                强制空闲
              </Button>
            ) : null}
          </Space>
        ) : null}
      </Space>
    </Spin>
  );

  return (
    <Popover
      content={content}
      open={open}
      placement="bottomRight"
      title="机台信息"
      trigger="click"
      onOpenChange={setOpen}
    >
      <Button>机台信息</Button>
    </Popover>
  );
}
