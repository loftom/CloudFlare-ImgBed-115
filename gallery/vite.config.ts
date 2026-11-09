import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-ignore 纯 JS 开发插件
import { pagesShim } from './mock/pages-shim.mjs';

// `vite --mode mock`：在 dev server 里跑 functions/ 的真实代码，上游是本地 mock ImgBed
export default defineConfig(({ mode, command }) => ({
  plugins: [react(), ...(command === 'serve' && mode === 'mock' ? [pagesShim()] : [])],
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
}));
