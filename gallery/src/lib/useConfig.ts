import { useEffect, useState } from 'react';
import { getConfig } from './api';
import type { GalleryConfig } from './types';

export function useConfig() {
  const [config, setConfig] = useState<GalleryConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    getConfig().then(
      (c) => alive && setConfig(c),
      (e) => alive && setError(String(e?.message || e)),
    );
    return () => {
      alive = false;
    };
  }, []);
  return { config, error };
}
