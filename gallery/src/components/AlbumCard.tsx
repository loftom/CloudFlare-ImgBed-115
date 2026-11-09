import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Folder, Image as ImageIcon, Layers } from 'lucide-react';
import { fetchCover, imageUrl } from '../lib/api';
import { dirToRoute } from '../lib/paths';
import { useNearViewport } from '../lib/useNearViewport';
import { QueuedImage } from './QueuedImage';
import type { CoverResponse, DirEntry } from '../lib/types';

/** 目录卡片（样式取自 115Deck AlbumCard）：2:3 海报、底部渐变托盘、悬停环境光晕。封面 = 目录第一张图 */
export const AlbumCard = React.memo(function AlbumCard({ dir, imageBase }: { dir: DirEntry; imageBase: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const near = useNearViewport(ref, '600px 0px');
  const [info, setInfo] = useState<CoverResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [bloom, setBloom] = useState<string | undefined>();

  useEffect(() => {
    if (!near || info || failed) return;
    let alive = true;
    // 封面失败只影响这一张卡片：占位，不把错误抛到目录页。
    fetchCover(dir.path).then(
      (r) => alive && setInfo(r),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [near, info, failed, dir.path]);

  const coverUrl = info?.cover ? imageUrl(imageBase, info.cover.path) : undefined;
  const noCover = (info && !info.cover) || failed;

  return (
    <Link
      ref={ref}
      to={dirToRoute(dir.path)}
      className="relative group block"
      aria-label={`打开目录：${dir.name}`}
      title={dir.name}
    >
      <div
        className="absolute -inset-2 rounded-3xl opacity-0 blur-xl transition-all duration-500 group-hover:opacity-45 pointer-events-none"
        style={bloom ? { backgroundImage: `url("${bloom}")`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
      />
      <div className="relative z-10 overflow-hidden rounded-2xl bg-slate-900/90 border border-slate-800/80 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.1),0_8px_24px_rgba(0,0,0,0.5)] transition-all duration-300 motion-safe:group-hover:-translate-y-1.5 group-hover:border-cyan-400/60 group-hover:shadow-[0_12px_36px_rgba(6,182,212,0.3)]">
        <div className="relative aspect-[2/3] w-full bg-black/40">
          {noCover ? (
            <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-950">
              <Folder className="w-12 h-12 text-slate-700" />
            </div>
          ) : (
            <QueuedImage
              url={coverUrl}
              enabled={!!coverUrl}
              alt={dir.name}
              className="absolute inset-0"
              imgClassName="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
              onLoaded={() => setBloom(coverUrl)}
            />
          )}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-slate-950 via-slate-950/85 to-transparent p-3 pt-12">
            <div className="text-sm font-medium text-slate-100 line-clamp-2 leading-snug group-hover:text-white">{dir.name}</div>
            <div className="flex items-center gap-1.5 mt-1.5 text-[10px] font-mono">
              {info ? (
                <>
                  {info.directFileCount > 0 && (
                    <span className="flex items-center gap-1 px-1.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                      <ImageIcon className="w-2.5 h-2.5" />
                      {info.directFileCount}P
                    </span>
                  )}
                  {info.childCount > 0 && (
                    <span className="flex items-center gap-1 px-1.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                      <Layers className="w-2.5 h-2.5" />
                      {info.childCount >= 500 ? '500+' : info.childCount} 个子目录
                    </span>
                  )}
                </>
              ) : (
                <span className="h-3.5 w-12 rounded bg-slate-800 animate-pulse" />
              )}
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
});
