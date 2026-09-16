import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发：Vite 提供前端，/api 代理到本地 Express。
// 生产：`npm run build` 产出 dist/web，由 Express 同源托管（见 src/server/index.ts）。
// 静态演示版（GitHub Pages）：构建时设 PAGES_BASE=/<仓库名>/ 与 VITE_STATIC_DEMO=1，
// 产物只含前端；见 .github/workflows/pages.yml。
export default defineConfig({
  base: process.env.PAGES_BASE ?? '/',
  plugins: [react()],
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
});
