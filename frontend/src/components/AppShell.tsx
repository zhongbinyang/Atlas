import { useEffect, useState } from 'react';
import { Layout, Menu } from 'antd';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { schedulerApi } from '../api/schedulerApi';
import { readBuildVersion } from '../lib/buildVersion';

const { Header, Content } = Layout;

const items = [
  { key: '/machines', label: <Link to="/machines">机台</Link> },
  { key: '/functions', label: <Link to="/functions">已注册功能</Link> },
  { key: '/sequences', label: <Link to="/sequences">序列模板</Link> },
  { key: '/runs', label: <Link to="/runs">运行</Link> },
  { key: '/configs', label: <Link to="/configs">机台配置</Link> },
  { key: '/specs', label: <Link to="/specs">Spec 模板</Link> },
  { key: '/units', label: <Link to="/units">单位</Link> },
];

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const selected = location.pathname.startsWith('/runs')
    ? '/runs'
    : items.find((i) => location.pathname.startsWith(i.key))?.key ?? '/machines';

  const [buildVersion, setBuildVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void schedulerApi
      .buildVersion()
      .then((data) => {
        const version = readBuildVersion(data);
        if (!cancelled) setBuildVersion(version);
      })
      .catch(() => {
        /* hide version line */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Layout className="atlas-shell">
      <Header className="atlas-header">
        <button type="button" className="atlas-brand" onClick={() => navigate('/machines')}>
          <span className="atlas-led" aria-hidden="true" />
          <span className="atlas-brand-text">
            <span className="atlas-wordmark">ATLAS</span>
            <span className="atlas-tagline">测试机台编排</span>
            {buildVersion ? (
              <span className="atlas-build-version" title="编译版本">
                {buildVersion}
              </span>
            ) : null}
          </span>
        </button>
        <Menu
          className="atlas-nav"
          theme="dark"
          mode="horizontal"
          selectedKeys={[selected]}
          items={items}
        />
      </Header>
      <Content className="atlas-content">
        <Outlet />
      </Content>
    </Layout>
  );
}
