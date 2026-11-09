import { useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { DirectoryPage } from './pages/DirectoryPage';
import { routeToDir } from './lib/paths';
import { useConfig } from './lib/useConfig';
import { ErrorState, LoadingState } from './components/StateViews';

export default function App() {
  const location = useLocation();
  const dir = routeToDir(location.pathname);
  const { config, error } = useConfig();
  const [drawer, setDrawer] = useState(false);

  return (
    <div className="min-h-screen">
      <Sidebar currentDir={dir} open={drawer} onClose={() => setDrawer(false)} configError={error} />

      <div className="md:pl-60">
        {/* 移动端顶栏 */}
        <div className="md:hidden sticky top-0 z-30 flex items-center gap-3 px-4 h-14 bg-slate-950/80 backdrop-blur-xl border-b border-slate-800/80">
          <button
            type="button"
            onClick={() => setDrawer(true)}
            className="p-2 -ml-2 rounded-lg text-slate-300 hover:bg-slate-800"
            aria-label="打开目录"
          >
            <Menu className="w-5 h-5" />
          </button>
          <span className="font-semibold text-slate-100">{config?.title || '私人图库'}</span>
        </div>

        <main className="px-4 sm:px-6 lg:px-8 py-6">
          {error ? (
            <ErrorState title="无法读取图库配置" message={error} />
          ) : !config ? (
            <LoadingState label="正在连接图库…" />
          ) : (
            <Routes>
              <Route path="/" element={<DirectoryPage key="/" dir="" config={config} />} />
              <Route path="/d/*" element={<DirectoryPage key={dir} dir={dir} config={config} />} />
              <Route path="*" element={<ErrorState title="页面不存在" message="请从左侧目录重新进入。" />} />
            </Routes>
          )}
        </main>
      </div>
    </div>
  );
}
