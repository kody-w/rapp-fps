import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  publicDir: false,
  server: {
    host: '127.0.0.1',
    port: 5332,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: resolve(root, '.dist'),
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1_000,
    rollupOptions: {
      input: resolve(root, 'harness.html'),
    },
  },
});
