import { Card, Typography } from 'antd';
import type { ReactNode } from 'react';
import { useState } from 'react';

type CollapsibleCardProps = {
  title: ReactNode;
  extra?: ReactNode;
  children?: ReactNode;
  /** When false (default), section starts collapsed. */
  defaultOpen?: boolean;
  size?: 'default' | 'small';
  className?: string;
};

/** Card whose header toggles body visibility. Extra actions do not toggle. */
export function CollapsibleCard({
  title,
  extra,
  children,
  defaultOpen = false,
  size,
  className,
}: CollapsibleCardProps) {
  const [open, setOpen] = useState(defaultOpen);

  const toggle = () => setOpen((v) => !v);

  const titleNode = (
    <span className="atlas-collapse-trigger">
      <span className={`atlas-collapse-chevron${open ? ' is-open' : ''}`} aria-hidden>
        ▸
      </span>
      <span className="atlas-collapse-title">{title}</span>
      {!open ? (
        <Typography.Text type="secondary" className="atlas-collapse-hint">
          点击展开
        </Typography.Text>
      ) : null}
    </span>
  );

  return (
    <Card
      size={size}
      className={`atlas-collapse-card${open ? ' is-open' : ' is-collapsed'}${className ? ` ${className}` : ''}`}
      title={titleNode}
      extra={
        <div className="atlas-collapse-extra" onClick={(e) => e.stopPropagation()}>
          {open ? extra : null}
        </div>
      }
      onClick={(e) => {
        const head = (e.currentTarget as HTMLElement).querySelector('.ant-card-head');
        if (head && head.contains(e.target as Node)) {
          // Ignore clicks on action buttons in extra
          if ((e.target as HTMLElement).closest('.atlas-collapse-extra')) return;
          toggle();
        }
      }}
      role="presentation"
    >
      {open ? <div aria-hidden={!open}>{children}</div> : null}
    </Card>
  );
}
