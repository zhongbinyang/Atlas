import { Typography } from 'antd';
import type { ReactNode } from 'react';

type PageHeaderProps = {
  title: string;
  description?: string;
  extra?: ReactNode;
};

export function PageHeader({ title, description, extra }: PageHeaderProps) {
  return (
    <div className="atlas-page-header">
      <div className="atlas-page-header-main">
        <Typography.Title level={3} className="atlas-page-title">
          {title}
        </Typography.Title>
        {description ? <p className="atlas-page-desc">{description}</p> : null}
      </div>
      {extra ? <div>{extra}</div> : null}
    </div>
  );
}
