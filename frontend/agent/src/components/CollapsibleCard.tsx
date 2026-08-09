import { Card, Typography } from 'antd';
import type { KeyboardEvent, ReactNode } from 'react';
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

  const toggle = () => setOpen((value) => !value);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  };

  const titleNode = (
    <button
      type="button"
      className="atlas-collapse-trigger"
      aria-expanded={open}
      onClick={toggle}
      onKeyDown={handleKeyDown}
    >
      <span className={`atlas-collapse-chevron${open ? ' is-open' : ''}`} aria-hidden>
        ▸
      </span>
      <span className="atlas-collapse-title">{title}</span>
      {!open ? (
        <Typography.Text type="secondary" className="atlas-collapse-hint">
          点击展开
        </Typography.Text>
      ) : null}
    </button>
  );

  return (
    <Card
      size={size}
      className={`atlas-collapse-card${open ? ' is-open' : ' is-collapsed'}${className ? ` ${className}` : ''}`}
      title={titleNode}
      extra={
        <div className="atlas-collapse-extra" onClick={(event) => event.stopPropagation()}>
          {open ? extra : null}
        </div>
      }
    >
      {open ? children : null}
    </Card>
  );
}
