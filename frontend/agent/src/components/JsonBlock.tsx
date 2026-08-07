import { Typography } from 'antd';

type JsonBlockProps = {
  value?: string | null;
  emptyText?: string;
  maxHeight?: number;
};

/** Read-only JSON / log panel with shared Agent styling. */
export function JsonBlock({
  value,
  emptyText = '暂无输出',
  maxHeight = 420,
}: JsonBlockProps) {
  const text = value?.trim() ? value : '';
  return (
    <pre className={`atlas-json${text ? '' : ' atlas-json-empty'}`} style={{ maxHeight }}>
      {text || emptyText}
    </pre>
  );
}

type JsonFieldHintProps = {
  children: string;
};

export function JsonFieldHint({ children }: JsonFieldHintProps) {
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
      {children}
    </Typography.Text>
  );
}
