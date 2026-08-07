import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { AgentDetailPage } from './pages/AgentDetailPage';
import { MachinesPage } from './pages/MachinesPage';
import { PlaceholderPage } from './pages/PlaceholderPage';

export function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <AntApp>
        <HashRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/machines" element={<MachinesPage />} />
              <Route path="/agents/:id" element={<AgentDetailPage />} />
              <Route path="/functions" element={<PlaceholderPage title="宸叉敞鍐屽姛鑳?" />} />
              <Route path="/sequences" element={<PlaceholderPage title="搴忓垪妯℃澘" />} />
              <Route path="/units" element={<PlaceholderPage title="鍗曚綅" />} />
              <Route path="*" element={<Navigate to="/machines" replace />} />
            </Route>
          </Routes>
        </HashRouter>
      </AntApp>
    </ConfigProvider>
  );
}
