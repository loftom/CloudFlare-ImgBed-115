import { AlertCircle, FolderOpen, Loader2, RotateCw } from 'lucide-react';

export function LoadingState({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[40vh] gap-3 text-slate-400">
      <Loader2 className="w-8 h-8 animate-spin text-cyan-400" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function ErrorState({ title, message, onRetry }: { title: string; message?: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[40vh] gap-3 text-center">
      <AlertCircle className="w-10 h-10 text-rose-400" />
      <p className="text-sm font-semibold text-rose-300">{title}</p>
      {message && <p className="text-xs text-slate-400 max-w-md break-all">{message}</p>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="flex items-center gap-2 px-4 py-2 mt-1 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-medium border border-white/15"
        >
          <RotateCw className="w-3.5 h-3.5" /> 重试
        </button>
      )}
    </div>
  );
}

export function EmptyState({ label = '这个目录是空的' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[30vh] gap-3 text-slate-500">
      <FolderOpen className="w-10 h-10" />
      <span className="text-sm">{label}</span>
    </div>
  );
}
