import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { AgentDetailPage } from './pages/AgentDetailPage';
import { ConfigsPage } from './pages/ConfigsPage';
import { FunctionsPage } from './pages/FunctionsPage';
import { MachinesPage } from './pages/MachinesPage';
import { SequencesPage } from './pages/SequencesPage';
import { UnitsPage } from './pages/UnitsPage';

export function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <AntApp>
        <HashRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/machines" element={<MachinesPage />} />
              <Route path="/agents/:id" element={<AgentDetailPage />} />
              <Route path="/functions" element={<FunctionsPage />} />
              <Route path="/sequences" element={<SequencesPage />} />
              <Route path="/configs" element={<ConfigsPage />} />
              <Route path="/units" element={<UnitsPage />} />
              <Route path="*" element={<Navigate to="/machines" replace />} />
            </Route>
          </Routes>
        </HashRouter>
      </AntApp>
    </ConfigProvider>
  );
}
