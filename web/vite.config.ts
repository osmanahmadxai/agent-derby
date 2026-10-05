import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const server = 'http://127.0.0.1:4747';

export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  build: {
    outDir: path.resolve(root, '../dist/web'),
    emptyOutDir: true,
  },
  server: {
    fs: { allow: [path.resolve(root, '..')] },
    proxy: {
      '/api': { target: server, changeOrigin: true },
      '/ws': { target: server, ws: true, changeOrigin: true },
    },
  },
});
