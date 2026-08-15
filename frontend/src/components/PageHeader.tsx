import { Button, Space, Typography } from 'antd';
import type { ReactNode } from 'react';

type PageHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  extra?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
};

export function PageHeader({
  title,
  description,
  extra,
  onBack,
  backLabel = '返回列表',
}: PageHeaderProps) {
  return (
    <Space direction="vertical" size={4} style={{ display: 'flex' }}>
      <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space>
          {onBack ? <Button onClick={onBack}>{backLabel}</Button> : null}
          <Typography.Title level={3} style={{ margin: 0 }}>
            {title}
          </Typography.Title>
        </Space>
        {extra ?? null}
      </Space>
      {description ? <Typography.Text type="secondary">{description}</Typography.Text> : null}
    </Space>
  );
}
