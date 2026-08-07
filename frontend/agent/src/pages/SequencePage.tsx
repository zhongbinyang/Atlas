import { Tabs } from 'antd';
import { SequenceEditTab } from './sequence/SequenceEditTab';
import { SequenceRunTab } from './sequence/SequenceRunTab';

export function SequencePage() {
  return (
    <Tabs
      defaultActiveKey="edit"
      items={[
        { key: 'edit', label: '编排', children: <SequenceEditTab /> },
        { key: 'run', label: '运行', children: <SequenceRunTab /> },
      ]}
    />
  );
}
