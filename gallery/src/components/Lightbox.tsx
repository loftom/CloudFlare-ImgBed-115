import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, Loader2, RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { imageUrl } from '../lib/api';
import { useOverlay } from '../lib/overlayStack';
import type { FileEntry } from '../lib/types';

const SWAP_DEBOUNCE_MS = 100;
const PREFETCH_DEBOUNCE_MS = 250;

interface Props {
  images: FileEntry[];
  index: number;
  total: number;
  imageBase: string;
  hasMore: boolean;
  onLoadMore: () => void;
  onChange: (i: number) => void;
  onClose: () => void;
}

function preload(url: string): HTMLImageElement {
  const img = new Image();
  img.referrerPolicy = 'no-referrer';
  img.decoding = 'async';
  img.src = url;
  return img;
}

/** 全屏原图灯箱（交互取自 115Deck Lightbox）：←/→/空格翻页、Esc 关闭、Z/双击缩放，预取前后相邻图 */
export function Lightbox({ images, index, total, imageBase, hasMore, onLoadMore, onChange, onClose }: Props) {
  const isTop = useOverlay(true);
  const [shown, setShown] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const wantNext = useRef(false);
  const touch = useRef<{ x: number; y: number; t: number } | null>(null);

  const file = images[index];
  const url = file ? imageUrl(imageBase, file.path) : null;

  // 当前帧：去抖后预加载，解码完成才切换，翻页不闪白
  useEffect(() => {
    if (!url) return;
    setZoomed(false);
    setLoading(true);
    setError(false);
    let cancelled = false;
    let img: HTMLImageElement | null = null;
    const timer = window.setTimeout(() => {
      img = preload(url);
      img.onload = () => {
        if (cancelled) return;
        setShown(url);
        setLoading(false);
      };
      img.onerror = () => {
        if (cancelled) return;
        setLoading(false);
        setError(true);
      };
    }, shown ? SWAP_DEBOUNCE_MS : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (img) {
        img.onload = null;
        img.onerror = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, retryKey]);

  // 预取相邻图（+1、+2、-1），并在接近已加载末尾时拉下一页
  useEffect(() => {
    const keep: HTMLImageElement[] = [];
    const timer = window.setTimeout(() => {
      for (const d of [1, 2, -1]) {
        const f = images[index + d];
        if (f) keep.push(preload(imageUrl(imageBase, f.path)));
      }
    }, PREFETCH_DEBOUNCE_MS);
    if (hasMore && index >= images.length - 4) onLoadMore();
    return () => {
      window.clearTimeout(timer);
      keep.length = 0;
    };
  }, [index, images, imageBase, hasMore, onLoadMore]);

  // 在最后一张按「下一张」且还有下一页：等新一页到达后自动前进
  useEffect(() => {
    if (wantNext.current && index < images.length - 1) {
      wantNext.current = false;
      onChange(index + 1);
    }
  }, [images.length, index, onChange]);

  const prev = useCallback(() => {
    if (index > 0) onChange(index - 1);
  }, [index, onChange]);
  const next = useCallback(() => {
    if (index < images.length - 1) onChange(index + 1);
    else if (hasMore) {
      wantNext.current = true;
      onLoadMore();
    }
  }, [index, images.length, hasMore, onChange, onLoadMore]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        setZoomed((z) => !z);
        return;
      }
      if (zoomed && e.key.startsWith('Arrow')) return; // 放大态方向键用于平移
      if (['ArrowLeft', 'ArrowUp', 'PageUp', 'a', 'A'].includes(e.key)) {
        e.preventDefault();
        prev();
      } else if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'd', 'D'].includes(e.key)) {
        e.preventDefault();
        next();
      } else if (e.key === 'Home') {
        e.preventDefault();
        onChange(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        onChange(images.length - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isTop, onClose, prev, next, zoomed, onChange, images.length]);

  const atEnd = index >= images.length - 1 && !hasMore;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`原图预览 ${index + 1} / ${total}`}
      className="fixed inset-0 z-[60] bg-black/95 backdrop-blur-2xl flex items-center justify-center animate-fadeIn"
      onClick={onClose}
      onTouchStart={(e) => {
        const t = e.touches[0];
        touch.current = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, t: Date.now() } : null;
      }}
      onTouchEnd={(e) => {
        const s = touch.current;
        touch.current = null;
        if (!s || zoomed) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - s.x;
        const dy = t.clientY - s.y;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2 && Date.now() - s.t < 600) {
          e.preventDefault();
          if (dx < 0) next();
          else prev();
        }
      }}
    >
      <div className="absolute top-4 inset-x-4 sm:inset-x-6 flex items-center justify-between gap-3 text-zinc-300 z-20 pointer-events-none">
        <div className="flex items-center gap-2 min-w-0 pointer-events-auto">
          <span className="font-mono text-xs bg-black/70 px-3 py-1.5 rounded-xl border border-white/10 backdrop-blur-md whitespace-nowrap">
            {index + 1} / {total}
          </span>
          <span className="hidden sm:inline text-xs text-zinc-400 truncate max-w-[40vw]" title={file?.path}>
            {file?.name}
          </span>
          {shown && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setZoomed((z) => !z);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-black/70 hover:bg-white/10 border border-white/10 text-xs"
              title="缩放 (Z / 双击)"
            >
              {zoomed ? <ZoomOut className="w-3.5 h-3.5" /> : <ZoomIn className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{zoomed ? '适应屏幕' : '原始尺寸'}</span>
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="p-2 rounded-xl bg-black/70 hover:bg-white/10 text-zinc-400 hover:text-white border border-white/10 pointer-events-auto"
          title="关闭 (Esc)"
          aria-label="关闭"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {index > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            prev();
          }}
          className="absolute left-2 sm:left-4 p-3 rounded-2xl bg-black/60 hover:bg-white/15 text-zinc-300 hover:text-white border border-white/10 backdrop-blur-md z-20"
          title="上一张 (←)"
          aria-label="上一张"
        >
          <ChevronLeft className="w-6 h-6" />
        </button>
      )}
      {!atEnd && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            next();
          }}
          className="absolute right-2 sm:right-4 p-3 rounded-2xl bg-black/60 hover:bg-white/15 text-zinc-300 hover:text-white border border-white/10 backdrop-blur-md z-20"
          title="下一张 (→ / 空格)"
          aria-label="下一张"
        >
          <ChevronRight className="w-6 h-6" />
        </button>
      )}

      <div
        onClick={(e) => e.stopPropagation()}
        className={`max-w-full max-h-full flex p-2 sm:p-4 ${zoomed ? 'overflow-auto w-full h-full' : 'items-center justify-center'}`}
      >
        {error ? (
          <div className="flex flex-col items-center gap-3 text-zinc-300 bg-[#0d1017]/95 border border-white/10 p-6 rounded-2xl text-center max-w-sm m-auto">
            <AlertCircle className="w-10 h-10 text-rose-400" />
            <p className="text-sm font-semibold text-rose-300">原图加载失败</p>
            <p className="text-xs text-zinc-400">ImgBed 读取超时或网络异常</p>
            <button
              type="button"
              onClick={() => setRetryKey((k) => k + 1)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs border border-white/15"
            >
              <RotateCw className="w-3.5 h-3.5" /> 重新加载
            </button>
          </div>
        ) : shown ? (
          <img
            src={shown}
            alt={file?.name || ''}
            referrerPolicy="no-referrer"
            draggable={false}
            onDoubleClick={() => setZoomed((z) => !z)}
            className={`rounded-lg shadow-2xl select-none ${
              zoomed ? 'max-w-none max-h-none m-auto cursor-zoom-out' : 'max-h-[92vh] max-w-[92vw] object-contain cursor-zoom-in'
            } ${loading ? 'opacity-60' : 'opacity-100'} transition-opacity duration-200`}
          />
        ) : (
          <div className="flex flex-col items-center gap-3 text-zinc-400 m-auto">
            <Loader2 className="w-8 h-8 animate-spin text-white/70" />
            <span className="text-xs font-mono">正在加载原图…</span>
          </div>
        )}
      </div>
      {loading && shown && (
        <div className="absolute bottom-6 right-6 flex items-center gap-2 px-3 py-1.5 rounded-xl bg-black/80 border border-white/10 text-zinc-300 text-xs font-mono">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载中…
        </div>
      )}
    </div>
  );
}
