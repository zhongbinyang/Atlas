import { App as AntdApp, Button, Layout, Menu, Space, Typography } from 'antd';
import { useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { agentApi } from '../api/agentApi';
import { MachineInfoPopover } from './MachineInfoPopover';

const { Header, Content } = Layout;

const items = [
  { key: '/vi', label: <Link to="/vi">VI</Link> },
  { key: '/general', label: <Link to="/general">閫氱敤</Link> },
  { key: '/api', label: <Link to="/api">REST</Link> },
  { key: '/sequence', label: <Link to="/sequence">搴忓垪</Link> },
  { key: '/settings', label: <Link to="/settings">閰嶇疆</Link> },
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
      message.success('注册成功');
    } catch (error) {
      message.error(`注册失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRegistering(false);
    }
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <div
          style={{ color: '#fff', cursor: 'pointer', lineHeight: 1.2 }}
          onClick={() => navigate('/vi')}
        >
          <Typography.Text strong style={{ color: '#fff', fontSize: 18 }}>
            ATLAS
          </Typography.Text>
          <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: 12 }}>娴嬭瘯鏈哄彴</div>
        </div>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[selected]}
          items={items}
          style={{ flex: 1, minWidth: 0 }}
        />
        <Space>
          <MachineInfoPopover />
          <Button loading={registering} onClick={handleRegisterNow}>
            重新注册
          </Button>
        </Space>
      </Header>
      <Content style={{ padding: 24 }}>
        <Outlet />
      </Content>
    </Layout>
  );
}
