import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发：Vite 提供前端，/api 代理到本地 Express。
// 生产：`npm run build` 产出 dist/web，由 Express 同源托管（见 src/server/index.ts）。
export default defineConfig({
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
