import { Typography } from 'antd';

export function PlaceholderPage({ title }: { title: string }) {
  return <Typography.Title level={3}>{title}</Typography.Title>;
}
