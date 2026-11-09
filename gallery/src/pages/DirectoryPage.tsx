import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { BookOpen, Grid3X3, Loader2, RefreshCw } from 'lucide-react';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { AlbumCard } from '../components/AlbumCard';
import { ImageGrid } from '../components/ImageGrid';
import { Lightbox } from '../components/Lightbox';
import { VerticalReader } from '../components/VerticalReader';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { useDirectory } from '../lib/useDirectory';
import { useNearViewport } from '../lib/useNearViewport';
import { useSettings } from '../lib/settings';
import { baseName } from '../lib/paths';
import type { GalleryConfig } from '../lib/types';

const DIR_CHUNK = 48;

export function DirectoryPage({ dir, config }: { dir: string; config: GalleryConfig }) {
  const { order } = useSettings();
  const d = useDirectory(dir, order);
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'reader' ? 'reader' : 'grid';
  const [lightbox, setLightbox] = useState<number | null>(null);

  const images = useMemo(() => d.files.filter((f) => f.kind === 'image'), [d.files]);
  const otherCount = d.files.length - images.length;
  const title = dir ? baseName(dir) : config.title || '全部';
  const imageTotal = Math.max(images.length, d.directFileCount - otherCount);

  // 目录墙分批渲染（ImgBed 一次返回全部子目录，最多 500 个）
  const [dirLimit, setDirLimit] = useState(DIR_CHUNK);
  const dirSentinel = useRef<HTMLDivElement>(null);
  const dirNearEnd = useNearViewport(dirSentinel, '800px 0px');
  useEffect(() => {
    if (!dirNearEnd || dirLimit >= d.directories.length) return;
    const el = dirSentinel.current;
    if (el && el.getBoundingClientRect().top > window.innerHeight + 800) return;
    setDirLimit((n) => n + DIR_CHUNK);
  }, [dirNearEnd, dirLimit, d.directories.length]);

  // 图片无限滚动
  const fileSentinel = useRef<HTMLDivElement>(null);
  const fileNearEnd = useNearViewport(fileSentinel, '1200px 0px');
  const { hasMore, loading, loadMore } = d;
  useEffect(() => {
    if (!fileNearEnd || !hasMore || loading || view !== 'grid') return;
    const el = fileSentinel.current;
    if (el && el.getBoundingClientRect().top > window.innerHeight + 1200) return;
    loadMore();
  }, [fileNearEnd, hasMore, loading, loadMore, view, d.files.length]);

  const setView = useCallback(
    (v: 'grid' | 'reader') => {
      const next = new URLSearchParams(params);
      if (v === 'reader') next.set('view', 'reader');
      else next.delete('view');
      setParams(next, { replace: false });
    },
    [params, setParams],
  );

  useEffect(() => {
    document.title = `${title} · ${config.title || '私人图库'}`;
  }, [title, config.title]);

  if (!d.initialLoaded && d.loading) return <LoadingState label="正在读取目录…" />;
  if (!d.initialLoaded && d.error) return <ErrorState title="目录读取失败" message={d.error} onRetry={d.reload} />;

  const hasDirs = d.directories.length > 0;
  const hasImages = images.length > 0;

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <Breadcrumbs dir={dir} />
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-slate-50 truncate" title={title}>
              {title}
            </h1>
            <p className="mt-1 text-xs text-slate-400 font-mono">
              {hasDirs && <span>{d.directories.length >= 500 ? '500+' : d.directories.length} 个子目录</span>}
              {hasDirs && d.directFileCount > 0 && <span> · </span>}
              {d.directFileCount > 0 && <span>{d.directFileCount} 个文件</span>}
              {d.orderFallback && <span className="text-amber-300"> · ImgBed 计数暂不可用，已按最新在前显示</span>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {hasImages && (
              <div className="flex rounded-xl border border-slate-700/80 bg-slate-900/60 p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setView('grid')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg ${view === 'grid' ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  <Grid3X3 className="w-3.5 h-3.5" /> 网格
                </button>
                <button
                  type="button"
                  onClick={() => setView('reader')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg ${view === 'reader' ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  <BookOpen className="w-3.5 h-3.5" /> 竖向阅读
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={d.reload}
              className="p-2 rounded-xl border border-slate-700/80 bg-slate-900/60 text-slate-400 hover:text-cyan-300"
              title="刷新"
              aria-label="刷新"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {!hasDirs && !hasImages && !d.hasMore && <EmptyState label={otherCount ? `这里有 ${otherCount} 个非图片文件，图库不显示` : '这个目录是空的'} />}

      {hasDirs && (
        <section>
          {hasImages && <h2 className="mb-3 text-xs font-semibold tracking-wider text-slate-400">子目录</h2>}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4 sm:gap-5">
            {d.directories.slice(0, dirLimit).map((sub) => (
              <AlbumCard key={sub.path} dir={sub} imageBase={config.imageBase} />
            ))}
          </div>
          <div ref={dirSentinel} className="h-4" />
          {d.directories.length >= 500 && (
            <p className="mt-2 text-xs text-amber-300/80">ImgBed 单次最多返回 500 个子目录，更多的子目录不会显示。</p>
          )}
        </section>
      )}

      {(hasImages || (d.hasMore && !hasDirs)) && (
        <section>
          {hasDirs && <h2 className="mb-3 text-xs font-semibold tracking-wider text-slate-400">图片</h2>}
          <ImageGrid images={images} imageBase={config.imageBase} onOpen={setLightbox} />
          <div ref={fileSentinel} className="py-6 flex flex-col items-center gap-2 text-xs text-slate-500">
            {d.error ? (
              <ErrorState title="下一页加载失败" message={d.error} onRetry={loadMore} />
            ) : d.hasMore ? (
              <button type="button" onClick={loadMore} className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-white/5">
                {d.loading && <Loader2 className="w-4 h-4 animate-spin" />}
                已加载 {images.length} / {imageTotal} 张{d.loading ? '，加载中…' : '，点击或继续下滑加载更多'}
              </button>
            ) : (
              <span>
                共 {images.length} 张{otherCount > 0 ? `（另有 ${otherCount} 个非图片文件未显示）` : ''}
              </span>
            )}
          </div>
        </section>
      )}

      {view === 'reader' && hasImages && createPortal(
        <VerticalReader
          title={title}
          images={images}
          total={imageTotal}
          imageBase={config.imageBase}
          hasMore={d.hasMore}
          loading={d.loading}
          onLoadMore={loadMore}
          onOpen={setLightbox}
          onClose={() => setView('grid')}
          suspended={lightbox !== null}
        />,
        document.body,
      )}

      {lightbox !== null && images[lightbox] && createPortal(
        <Lightbox
          images={images}
          index={lightbox}
          total={imageTotal}
          imageBase={config.imageBase}
          hasMore={d.hasMore}
          onLoadMore={loadMore}
          onChange={setLightbox}
          onClose={() => setLightbox(null)}
        />,
        document.body,
      )}
    </div>
  );
}
