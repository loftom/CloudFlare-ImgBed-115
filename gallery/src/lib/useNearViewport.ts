import { RefObject, useEffect, useRef, useState } from 'react';

type Cb = (visible: boolean) => void;
const observers = new Map<string, { io: IntersectionObserver; cbs: WeakMap<Element, Cb> }>();

function getObserver(margin: string, rootId?: string) {
  const root = rootId ? document.getElementById(rootId) : null;
  const key = `${margin}|${rootId || 'viewport'}`;
  let entry = observers.get(key);
  // 滚动容器被卸载重建（如阅读器关闭后再打开）时需要换一个观察者
  if (entry && rootId && (entry.io.root as Element | null) !== root) {
    entry.io.disconnect();
    entry = undefined;
  }
  if (!entry) {
    const cbs = new WeakMap<Element, Cb>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) cbs.get(e.target)?.(e.isIntersecting);
      },
      { rootMargin: margin, root },
    );
    entry = { io, cbs };
    observers.set(key, entry);
  }
  return entry;
}

/**
 * 共享 IntersectionObserver：几百张卡片共用一个观察者。
 * 每次渲染后检查 ref 指向的元素是否变化（元素可能晚于首次渲染才挂载），变化时重新观察。
 */
export function useNearViewport(ref: RefObject<Element>, margin = '600px 0px', rootId?: string): boolean {
  const [visible, setVisible] = useState(false);
  const observed = useRef<{ el: Element; io: IntersectionObserver; cbs: WeakMap<Element, Cb> } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (observed.current?.el === el) return;
    if (observed.current) {
      observed.current.io.unobserve(observed.current.el);
      observed.current.cbs.delete(observed.current.el);
      observed.current = null;
    }
    if (!el) {
      setVisible(false);
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const { io, cbs } = getObserver(margin, rootId);
    cbs.set(el, setVisible);
    io.observe(el);
    observed.current = { el, io, cbs };
  });

  useEffect(
    () => () => {
      if (observed.current) {
        observed.current.io.unobserve(observed.current.el);
        observed.current.cbs.delete(observed.current.el);
        observed.current = null;
      }
    },
    [],
  );

  return visible;
}
