import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    sourcemap: false,
    target: ['es2022', 'safari15'],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Same-origin /api in development; the gateway checks Origin = APP_ORIGIN (http://localhost:5173).
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
});
