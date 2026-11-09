import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchList } from './api';
import type { DirEntry, FileEntry, Order } from './types';

const PAGE_SIZE = 60;

interface State {
  dir: string;
  order: Order;
  directories: DirEntry[];
  files: FileEntry[];
  /** 已从接口取到的条目数（含非图片），用作下一页 start */
  fetched: number;
  directFileCount: number;
  totalCount: number;
  hasMore: boolean;
  loading: boolean;
  initialLoaded: boolean;
  error: string | null;
  effectiveOrder: Order;
  orderFallback: boolean;
  countsUnavailable: boolean;
}

function empty(dir: string, order: Order): State {
  return {
    dir, order, directories: [], files: [], fetched: 0, directFileCount: 0, totalCount: 0,
    hasMore: false, loading: true, initialLoaded: false, error: null, effectiveOrder: order,
    orderFallback: false, countsUnavailable: false,
  };
}

/** 分页加载一个目录：首屏拿子目录 + 第一页文件，之后 loadMore 追加 */
export function useDirectory(dir: string, order: Order) {
  const [state, setState] = useState<State>(() => empty(dir, order));
  const stateRef = useRef(state);
  stateRef.current = state;
  const inflight = useRef<AbortController | null>(null);
  const loadingRef = useRef(false);

  const load = useCallback(
    async (reset: boolean) => {
      const s = reset ? empty(dir, order) : stateRef.current;
      if (!reset && (loadingRef.current || !s.hasMore)) return;
      inflight.current?.abort();
      const ac = new AbortController();
      inflight.current = ac;
      loadingRef.current = true;
      if (reset) setState(s);
      else setState((p) => ({ ...p, loading: true, error: null }));
      try {
        const r = await fetchList(
          {
            dir,
            start: s.fetched,
            count: PAGE_SIZE,
            order: s.effectiveOrder,
            total: s.initialLoaded ? s.directFileCount : undefined,
          },
          ac.signal,
        );
        if (ac.signal.aborted) return;
        setState((p) => ({
          ...p,
          directories: reset || !p.initialLoaded ? r.directories : p.directories,
          files: reset ? r.files : [...p.files, ...r.files],
          fetched: (reset ? 0 : p.fetched) + r.files.length,
          directFileCount: r.directFileCount,
          totalCount: r.totalCount,
          hasMore: r.hasMore && r.files.length > 0,
          loading: false,
          initialLoaded: true,
          error: null,
          effectiveOrder: r.order,
          orderFallback: !!r.orderFallback,
          countsUnavailable: !!r.countsUnavailable,
        }));
      } catch (e) {
        if (ac.signal.aborted) return;
        setState((p) => ({ ...p, loading: false, error: String((e as Error)?.message || e) }));
      } finally {
        if (inflight.current === ac) loadingRef.current = false;
      }
    },
    [dir, order],
  );

  useEffect(() => {
    load(true);
    return () => inflight.current?.abort();
  }, [load]);

  const loadMore = useCallback(() => load(false), [load]);
  const reload = useCallback(() => load(true), [load]);

  return { ...state, loadMore, reload };
}
