import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { imageUrl } from '../lib/api';
import { useOverlay } from '../lib/overlayStack';
import { useNearViewport } from '../lib/useNearViewport';
import { QueuedImage } from './QueuedImage';
import type { FileEntry } from '../lib/types';

const ROOT_ID = 'reader-scroll';

interface Props {
  title: string;
  images: FileEntry[];
  total: number;
  imageBase: string;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  onOpen: (i: number) => void;
  onClose: () => void;
  /** 灯箱打开时暂停阅读器自己的键盘处理 */
  suspended: boolean;
}

/** 竖向阅读（布局取自 115Deck VerticalReader）：整套图从上到下连续展示，J/K 或 ←/→ 跳张，Esc 返回 */
export function VerticalReader({ title, images, total, imageBase, hasMore, loading, onLoadMore, onOpen, onClose, suspended }: Props) {
  const isTop = useOverlay(true);
  const [current, setCurrent] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const nearEnd = useNearViewport(sentinel, '1500px 0px', ROOT_ID);

  useEffect(() => {
    if (!nearEnd || !hasMore || loading) return;
    const el = sentinel.current;
    const root = scrollRef.current;
    if (el && root && el.getBoundingClientRect().top - root.getBoundingClientRect().bottom > 1500) return;
    onLoadMore();
  }, [nearEnd, hasMore, loading, onLoadMore, images.length]);

  const jump = useCallback((i: number) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-idx="${i}"]`);
    el?.scrollIntoView({ block: 'start' });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (suspended || !isTop()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (['j', 'J', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        jump(Math.min(images.length - 1, current + 1));
      } else if (['k', 'K', 'ArrowLeft'].includes(e.key)) {
        e.preventDefault();
        jump(Math.max(0, current - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [suspended, isTop, onClose, jump, current, images.length]);

  return (
    <div className="fixed inset-0 z-50 bg-[#07080b]/98 backdrop-blur-3xl flex flex-col overflow-hidden animate-fadeIn">
      <header className="flex items-center justify-between gap-3 px-3 sm:px-6 py-3.5 bg-slate-900/90 border-b border-slate-800/80 backdrop-blur-md">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-300 bg-slate-800 hover:bg-slate-700 hover:text-cyan-300 rounded-lg border border-slate-700 hover:border-cyan-500/40 flex-shrink-0"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="hidden sm:inline">返回网格 (Esc)</span>
          </button>
          <h2 className="text-sm font-medium text-slate-200 truncate" title={title}>
            {title}
          </h2>
        </div>
        <div className="flex items-center gap-2 text-xs font-mono text-slate-300 flex-shrink-0">
          <span className="bg-slate-800/80 px-2.5 py-1 rounded-md border border-slate-700">
            {Math.min(current + 1, images.length)} / {total}
          </span>
        </div>
      </header>
      <div className="h-0.5 bg-slate-800">
        <div className="h-full bg-gradient-to-r from-cyan-400 to-indigo-500 transition-all" style={{ width: `${total ? ((current + 1) / total) * 100 : 0}%` }} />
      </div>

      <div id={ROOT_ID} ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain px-2 sm:px-6 py-6">
        <div className="mx-auto w-full max-w-[960px] flex flex-col gap-3">
          {images.map((f, i) => (
            <ReaderItem key={f.path} file={f} index={i} imageBase={imageBase} onActive={setCurrent} onOpen={onOpen} />
          ))}
          <div ref={sentinel} className="py-8 flex justify-center text-xs text-slate-500">
            {hasMore ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> 加载更多…
              </span>
            ) : (
              <span>— 全部 {images.length} 张已看完 —</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const ReaderItem = React.memo(function ReaderItem({
  file, index, imageBase, onActive, onOpen,
}: { file: FileEntry; index: number; imageBase: string; onActive: (i: number) => void; onOpen: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  const atCenter = useNearViewport(ref, '-50% 0px -50% 0px', ROOT_ID);
  useEffect(() => {
    if (atCenter) onActive(index);
  }, [atCenter, index, onActive]);

  return (
    <div ref={ref} data-idx={index} className="relative scroll-mt-2">
      <button type="button" className="block w-full cursor-zoom-in" onClick={() => onOpen(index)} aria-label={`放大第 ${index + 1} 张`}>
        <QueuedImage
          url={imageUrl(imageBase, file.path)}
          alt={file.name}
          rootId={ROOT_ID}
          margin="1600px 0px"
          className={`rounded-lg bg-[#0d1017] ${ratio ? '' : 'aspect-[2/3]'}`}
          imgClassName={ratio ? 'block w-full h-auto' : 'absolute inset-0 w-full h-full object-contain'}
          onLoaded={(img) => setRatio(img.naturalWidth / Math.max(1, img.naturalHeight))}
        />
      </button>
      <span className="absolute top-2 left-2 px-2 py-0.5 text-[10px] font-mono bg-black/60 text-zinc-300 rounded-md border border-white/10 pointer-events-none">
        {index + 1}
      </span>
    </div>
  );
});
