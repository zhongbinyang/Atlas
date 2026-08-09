import { Tabs } from 'antd';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { SequenceEditTab } from './sequence/SequenceEditTab';
import { SequenceRunTab } from './sequence/SequenceRunTab';

const SEQUENCE_TABS = ['edit', 'run'] as const;
type SequenceTab = (typeof SEQUENCE_TABS)[number];

function isSequenceTab(value: string | undefined): value is SequenceTab {
  return value === 'edit' || value === 'run';
}

export function SequencePage() {
  const { tab } = useParams();
  const navigate = useNavigate();

  if (!isSequenceTab(tab)) {
    return <Navigate to="/sequence/edit" replace />;
  }

  return (
    <div className="atlas-page">
      <PageHeader
        title="序列"
        description="先在「编排」组装步骤与资源锁，再到「运行」按通道执行并查看进度。"
      />
      <Tabs
        activeKey={tab}
        onChange={(key) => navigate(`/sequence/${key}`)}
        type="card"
        items={[
          { key: 'edit', label: '编排', children: <SequenceEditTab /> },
          { key: 'run', label: '运行', children: <SequenceRunTab /> },
        ]}
      />
    </div>
  );
}
