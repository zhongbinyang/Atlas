import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { AgentDetailPage } from './pages/AgentDetailPage';
import { ConfigsPage } from './pages/ConfigsPage';
import { FunctionsPage } from './pages/FunctionsPage';
import { MachinesPage } from './pages/MachinesPage';
import { RunsPage } from './pages/RunsPage';
import { SequencesPage } from './pages/SequencesPage';
import { SpecEditorPage } from './pages/SpecEditorPage';
import { SpecsPage } from './pages/SpecsPage';
import { StationConfigPage } from './pages/StationConfigPage';
import { UnitsPage } from './pages/UnitsPage';
import { atlasTheme } from './theme';

export function App() {
  return (
    <ConfigProvider locale={zhCN} theme={atlasTheme}>
      <AntApp>
        <HashRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/machines" element={<MachinesPage />} />
              <Route path="/agents/:id" element={<AgentDetailPage />} />
              <Route path="/functions" element={<FunctionsPage />} />
              <Route path="/sequences" element={<SequencesPage />} />
              <Route path="/runs" element={<RunsPage />} />
              <Route path="/runs/:id" element={<RunsPage />} />
              <Route path="/configs" element={<ConfigsPage />} />
              <Route path="/configs/:agentId" element={<StationConfigPage />} />
              <Route path="/specs" element={<SpecsPage />} />
              <Route path="/specs/new" element={<SpecEditorPage />} />
              <Route path="/specs/:id" element={<SpecEditorPage />} />
              <Route path="/units" element={<UnitsPage />} />
              <Route path="*" element={<Navigate to="/machines" replace />} />
            </Route>
          </Routes>
        </HashRouter>
      </AntApp>
    </ConfigProvider>
  );
}
