import React, { useRef } from 'react';
import { AlertTriangle, Image as ImageIcon, RotateCw } from 'lucide-react';
import { useQueuedImage, Priority } from '../lib/imageQueue';
import { useNearViewport } from '../lib/useNearViewport';

interface Props {
  url?: string;
  alt: string;
  className?: string;
  imgClassName?: string;
  /** 额外控制：false 时即使在视口内也不加载（例如封面地址尚未就绪） */
  enabled?: boolean;
  rootId?: string;
  margin?: string;
  placeholder?: React.ReactNode;
  onLoaded?: (img: HTMLImageElement) => void;
}

/**
 * 并发受限的懒加载图片：接近视口才排队，视口内 high、附近 low；加载完成 300ms 淡入。
 * referrerPolicy=no-referrer：不向 ImgBed 发送 Referer，避免被「放行域名」防盗链拦截（见 README）。
 */
export function QueuedImage({
  url, alt, className = '', imgClassName = '', enabled = true, rootId, margin = '800px 0px', placeholder, onLoaded,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref, margin, rootId);
  const inView = useNearViewport(ref, '0px', rootId);
  const priority: Priority = inView ? 'high' : 'low';
  const { src, state, onLoad, onError, retry } = useQueuedImage(url, enabled && near, priority);

  return (
    <div ref={ref} className={`${/\b(absolute|fixed)\b/.test(className) ? '' : 'relative'} overflow-hidden ${className}`}>
      {state !== 'loaded' && state !== 'error' && (
        placeholder ?? (
          <div className="absolute inset-0 bg-[#12151e] animate-pulse flex items-center justify-center">
            <ImageIcon className="w-7 h-7 text-zinc-700" />
          </div>
        )
      )}
      {state === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/40 text-zinc-400">
          <AlertTriangle className="w-7 h-7 text-amber-400/80" />
          <span className="text-xs">图片读取失败</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              retry();
            }}
            className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-white/10 hover:bg-white/15 text-white text-[11px] border border-white/10"
          >
            <RotateCw className="w-3 h-3" /> 重试
          </button>
        </div>
      )}
      {src && (
        <img
          src={src}
          alt={alt}
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={(e) => {
            onLoad();
            onLoaded?.(e.currentTarget);
          }}
          onError={onError}
          className={`${imgClassName} transition-opacity duration-300 ${state === 'loaded' ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
    </div>
  );
}
