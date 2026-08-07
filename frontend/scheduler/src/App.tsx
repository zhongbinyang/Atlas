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
              <Route path="/machines" element={<PlaceholderPage title="鏈哄彴" />} />
              <Route path="/agents/:id" element={<PlaceholderPage title="鏈哄彴璇︽儏" />} />
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
