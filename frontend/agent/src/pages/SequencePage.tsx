import { Tabs } from 'antd';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { SequenceEditTab } from './sequence/SequenceEditTab';
import { SequenceRunTab } from './sequence/SequenceRunTab';

export function SequencePage() {
  const location = useLocation();
  const tabFromState =
    (location.state as { tab?: string } | null)?.tab === 'run' ? 'run' : null;
  const [activeKey, setActiveKey] = useState(tabFromState ?? 'edit');

  useEffect(() => {
    if (tabFromState) setActiveKey(tabFromState);
  }, [tabFromState, location.key]);

  return (
    <div className="atlas-page">
      <PageHeader
        title="序列"
        description="先在「编排」组装步骤与资源锁，再到「运行」按通道执行并查看进度。"
      />
      <Tabs
        activeKey={activeKey}
        onChange={setActiveKey}
        type="card"
        items={[
          { key: 'edit', label: '编排', children: <SequenceEditTab /> },
          { key: 'run', label: '运行', children: <SequenceRunTab /> },
        ]}
      />
    </div>
  );
}
