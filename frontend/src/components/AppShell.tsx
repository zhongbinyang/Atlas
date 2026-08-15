import { Layout, Menu, Typography } from 'antd';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';

const { Header, Content } = Layout;

const items = [
  { key: '/machines', label: <Link to="/machines">机台</Link> },
  { key: '/functions', label: <Link to="/functions">已注册功能</Link> },
  { key: '/sequences', label: <Link to="/sequences">序列模板</Link> },
  { key: '/configs', label: <Link to="/configs">机台配置</Link> },
  { key: '/specs', label: <Link to="/specs">Spec 模板</Link> },
  { key: '/units', label: <Link to="/units">单位</Link> },
];

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const selected = items.find((i) => location.pathname.startsWith(i.key))?.key ?? '/machines';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <div
          style={{ color: '#fff', cursor: 'pointer', lineHeight: 1.2 }}
          onClick={() => navigate('/machines')}
        >
          <Typography.Text strong style={{ color: '#fff', fontSize: 18 }}>
            ATLAS
          </Typography.Text>
          <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: 12 }}>测试机台编排</div>
        </div>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[selected]}
          items={items}
          style={{ flex: 1, minWidth: 0 }}
        />
      </Header>
      <Content style={{ padding: 24 }}>
        <Outlet />
      </Content>
    </Layout>
  );
}
