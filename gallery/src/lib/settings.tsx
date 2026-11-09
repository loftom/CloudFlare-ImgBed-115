import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { Order } from './types';
import { setMaxConcurrent } from './imageQueue';

interface Settings {
  order: Order;
  concurrency: number;
  setOrder: (o: Order) => void;
  setConcurrency: (n: number) => void;
}

const Ctx = createContext<Settings | null>(null);
const KEY = 'gallery.settings.v1';

function load(): { order: Order; concurrency: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      order: raw.order === 'desc' ? 'desc' : 'asc',
      concurrency: Number.isFinite(raw.concurrency) ? Math.min(12, Math.max(1, raw.concurrency)) : 4,
    };
  } catch {
    return { order: 'asc', concurrency: 4 };
  }
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const initial = useMemo(load, []);
  const [order, setOrder] = useState<Order>(initial.order);
  const [concurrency, setConcurrency] = useState(initial.concurrency);

  useEffect(() => {
    setMaxConcurrent(concurrency);
    localStorage.setItem(KEY, JSON.stringify({ order, concurrency }));
  }, [order, concurrency]);

  const value = useMemo(() => ({ order, concurrency, setOrder, setConcurrency }), [order, concurrency]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings() {
  const v = useContext(Ctx);
  if (!v) throw new Error('SettingsProvider missing');
  return v;
}
