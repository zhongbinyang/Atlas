import { App as AntdApp, Button, Layout, Menu, Space } from 'antd';
import { useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { agentApi } from '../api/agentApi';
import { MachineInfoPopover } from './MachineInfoPopover';

const { Header, Content } = Layout;

const items = [
  { key: '/vi', label: <Link to="/vi">VI</Link> },
  { key: '/general', label: <Link to="/general">通用</Link> },
  { key: '/api', label: <Link to="/api">REST</Link> },
  { key: '/sequence', label: <Link to="/sequence">序列</Link> },
  { key: '/settings', label: <Link to="/settings">配置</Link> },
];

export function AppShell() {
  const { message } = AntdApp.useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const [registering, setRegistering] = useState(false);
  const selected = items.find((i) => location.pathname.startsWith(i.key))?.key ?? '/vi';

  const handleRegisterNow = async () => {
    setRegistering(true);
    try {
      await agentApi.registerNow();
      message.success('已向中心重新注册');
    } catch (error) {
      message.error(`注册失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRegistering(false);
    }
  };

  return (
    <Layout className="atlas-shell">
      <Header className="atlas-header">
        <div className="atlas-brand" onClick={() => navigate('/vi')} role="link" tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              navigate('/vi');
            }
          }}
        >
          <span className="atlas-brand-mark">ATLAS</span>
          <span className="atlas-brand-sub">测试机台</span>
        </div>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[selected]}
          items={items}
          className="atlas-header-menu"
        />
        <Space className="atlas-header-actions" size="small">
          <MachineInfoPopover />
          <Button ghost loading={registering} onClick={handleRegisterNow}>
            重新注册
          </Button>
        </Space>
      </Header>
      <Content>
        <div className="atlas-content">
          <Outlet />
        </div>
      </Content>
    </Layout>
  );
}
