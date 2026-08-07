import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { GeneralPage } from './pages/GeneralPage';
import { RestPage } from './pages/RestPage';
import { SequencePage } from './pages/SequencePage';
import { SettingsPage } from './pages/SettingsPage';
import { ViPage } from './pages/ViPage';

export function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <AntApp>
        <HashRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/vi" element={<ViPage />} />
              <Route path="/general" element={<GeneralPage />} />
              <Route path="/api" element={<RestPage />} />
              <Route path="/sequence" element={<SequencePage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/vi" replace />} />
            </Route>
          </Routes>
        </HashRouter>
      </AntApp>
    </ConfigProvider>
  );
}
