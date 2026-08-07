import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { PlaceholderPage } from './pages/PlaceholderPage';

export function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <AntApp>
        <HashRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/vi" element={<PlaceholderPage title="VI" />} />
              <Route path="/general" element={<PlaceholderPage title="閫氱敤" />} />
              <Route path="/api" element={<PlaceholderPage title="REST" />} />
              <Route path="/sequence" element={<PlaceholderPage title="搴忓垪" />} />
              <Route path="/settings" element={<PlaceholderPage title="閰嶇疆" />} />
              <Route path="*" element={<Navigate to="/vi" replace />} />
            </Route>
          </Routes>
        </HashRouter>
      </AntApp>
    </ConfigProvider>
  );
}
