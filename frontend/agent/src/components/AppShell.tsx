import { Button, Layout, Menu, Space, Typography } from 'antd';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';

const { Header, Content } = Layout;

const items = [
  { key: '/vi', label: <Link to="/vi">VI</Link> },
  { key: '/general', label: <Link to="/general">閫氱敤</Link> },
  { key: '/api', label: <Link to="/api">REST</Link> },
  { key: '/sequence', label: <Link to="/sequence">搴忓垪</Link> },
  { key: '/settings', label: <Link to="/settings">閰嶇疆</Link> },
];

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const selected = items.find((i) => location.pathname.startsWith(i.key))?.key ?? '/vi';

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
          <Button disabled>Popover</Button>
          <Button disabled>閲嶆柊娉ㄥ唽</Button>
        </Space>
      </Header>
      <Content style={{ padding: 24 }}>
        <Outlet />
      </Content>
    </Layout>
  );
}
