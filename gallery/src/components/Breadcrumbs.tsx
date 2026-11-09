import { Link } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';
import { breadcrumbs, dirToRoute } from '../lib/paths';

export function Breadcrumbs({ dir }: { dir: string }) {
  const crumbs = breadcrumbs(dir);
  return (
    <nav aria-label="面包屑" className="flex items-center flex-wrap gap-1 text-sm text-slate-400 min-w-0">
      <Link to="/" className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-white/5 hover:text-cyan-300">
        <Home className="w-3.5 h-3.5" /> 全部
      </Link>
      {crumbs.map((c, i) => (
        <span key={c.path} className="flex items-center gap-1 min-w-0">
          <ChevronRight className="w-3.5 h-3.5 text-slate-600 flex-shrink-0" />
          {i === crumbs.length - 1 ? (
            <span className="px-2 py-1 text-slate-100 font-medium truncate max-w-[60vw]" title={c.name}>
              {c.name}
            </span>
          ) : (
            <Link to={dirToRoute(c.path)} className="px-2 py-1 rounded-lg hover:bg-white/5 hover:text-cyan-300 truncate max-w-[40vw]" title={c.name}>
              {c.name}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
