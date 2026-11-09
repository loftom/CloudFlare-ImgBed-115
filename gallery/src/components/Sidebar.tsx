import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Folder, Home, Images, ListOrdered, Gauge, X } from 'lucide-react';
import { fetchList } from '../lib/api';
import { dirToRoute } from '../lib/paths';
import { useSettings } from '../lib/settings';
import type { DirEntry } from '../lib/types';

interface Props {
  currentDir: string;
  open: boolean;
  onClose: () => void;
  configError: string | null;
}

/** 毛玻璃侧栏（样式取自 115Deck Sidebar）：顶层目录导航 + 浏览设置 */
export function Sidebar({ currentDir, open, onClose, configError }: Props) {
  const [roots, setRoots] = useState<DirEntry[]>([]);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const { order, setOrder, concurrency, setConcurrency } = useSettings();

  useEffect(() => {
    if (configError) {
      setStatus('error');
      return;
    }
    fetchList({ dir: '', start: 0, count: 1, order: 'desc' }).then(
      (r) => {
        setRoots(r.directories);
        setStatus('ok');
      },
      () => setStatus('error'),
    );
  }, [configError]);

  useEffect(() => {
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDir]);

  const top = currentDir.split('/')[0] || '';

  const nav = (
    <aside className="h-full w-60 bg-slate-950/70 border-r border-slate-800/80 flex flex-col backdrop-blur-2xl shadow-2xl shadow-black/60">
      <div className="h-16 px-5 flex items-center justify-between border-b border-slate-800/80 bg-slate-900/40">
        <Link to="/" className="flex items-center gap-3">
          <div className="relative group">
            <div className="absolute -inset-0.5 bg-gradient-to-tr from-cyan-500 via-indigo-500 to-pink-500 rounded-xl blur-[3px] opacity-75 group-hover:opacity-100 transition duration-500" />
            <div className="relative w-8 h-8 rounded-xl bg-slate-950 flex items-center justify-center border border-white/10 shadow-lg">
              <Images className="w-4 h-4 text-cyan-400" />
            </div>
          </div>
          <div>
            <div className="font-bold text-base tracking-wide bg-gradient-to-r from-white via-slate-100 to-slate-300 bg-clip-text text-transparent">
              私人图库
            </div>
            <p className="text-[10px] text-slate-400 font-mono tracking-tighter">ImgBed Gallery</p>
          </div>
        </Link>
        <button type="button" onClick={onClose} className="md:hidden p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800" aria-label="关闭">
          <X className="w-5 h-5" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-1">
        <div className="px-3 pt-1.5 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 font-mono">目录</div>
        <NavItem to="/" label="全部" icon={<Home className="w-4 h-4" />} active={currentDir === ''} />
        {roots.map((d) => (
          <NavItem key={d.path} to={dirToRoute(d.path)} label={d.name} icon={<Folder className="w-4 h-4" />} active={top === d.path} />
        ))}
        {status === 'loading' && <div className="px-3 py-2 text-xs text-slate-500">读取中…</div>}
      </nav>

      <div className="p-3 border-t border-white/[0.06] bg-black/20 space-y-2">
        <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06] space-y-2">
          <div className="flex items-center gap-2 text-[11px] text-slate-400">
            <ListOrdered className="w-3.5 h-3.5" /> 图片顺序
          </div>
          <div className="grid grid-cols-2 gap-1 text-xs">
            {(['asc', 'desc'] as const).map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => setOrder(o)}
                className={`px-2 py-1.5 rounded-lg border transition-colors ${
                  order === o
                    ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40'
                    : 'bg-transparent text-slate-400 border-slate-700/60 hover:text-slate-200'
                }`}
              >
                {o === 'asc' ? '上传顺序' : '最新在前'}
              </button>
            ))}
          </div>
          <label className="flex items-center justify-between gap-2 text-[11px] text-slate-400 pt-1">
            <span className="flex items-center gap-2">
              <Gauge className="w-3.5 h-3.5" /> 并发加载
            </span>
            <select
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              className="bg-slate-900 border border-slate-700 rounded-md px-1.5 py-0.5 text-slate-200"
            >
              {[2, 3, 4, 6, 8].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="p-2 rounded-xl bg-white/[0.03] border border-white/[0.06] flex items-center gap-2 text-xs">
          <span className="relative flex h-2 w-2">
            <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 ${status === 'ok' ? 'animate-ping bg-emerald-400' : status === 'error' ? 'bg-rose-400' : 'bg-amber-400'}`} />
            <span className={`relative inline-flex rounded-full h-2 w-2 ${status === 'ok' ? 'bg-emerald-500' : status === 'error' ? 'bg-rose-500' : 'bg-amber-500'}`} />
          </span>
          <span className="font-mono text-[11px] text-zinc-300">
            {status === 'ok' ? 'ImgBed 已连接' : status === 'error' ? 'ImgBed 连接失败' : '连接中…'}
          </span>
        </div>
      </div>
    </aside>
  );

  return (
    <>
      <div className="hidden md:block fixed inset-y-0 left-0 z-40">{nav}</div>
      {open && (
        <div className="md:hidden fixed inset-0 z-50 flex animate-fadeIn">
          <div className="h-full">{nav}</div>
          <button type="button" aria-label="关闭目录" className="flex-1 bg-black/60" onClick={onClose} />
        </div>
      )}
    </>
  );
}

function NavItem({ to, label, icon, active }: { to: string; label: string; icon: ReactNode; active: boolean }) {
  return (
    <Link
      to={to}
      className={`group relative w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl transition duration-200 overflow-hidden ${
        active
          ? 'bg-gradient-to-r from-cyan-500/15 via-indigo-500/10 to-transparent text-white border border-cyan-500/25'
          : 'text-slate-400 hover:text-slate-100 hover:bg-white/[0.04] border border-transparent'
      }`}
    >
      {active && (
        <div className="absolute left-0 top-1.5 bottom-1.5 w-1 bg-gradient-to-b from-cyan-400 to-indigo-500 rounded-r-full shadow-[0_0_8px_rgba(6,182,212,0.9)]" />
      )}
      <span className="flex items-center gap-3 min-w-0">
        <span className={active ? 'text-cyan-400' : 'text-slate-400 group-hover:text-slate-300'}>{icon}</span>
        <span className="text-sm tracking-wide truncate">{label}</span>
      </span>
      {active && <ChevronRight className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />}
    </Link>
  );
}
