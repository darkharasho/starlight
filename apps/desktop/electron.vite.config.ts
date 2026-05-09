import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: { outDir: 'out/main', lib: { entry: resolve(__dirname, 'src/main/index.ts') } },
  },
  preload: {
    build: { outDir: 'out/preload', lib: { entry: resolve(__dirname, 'src/preload/index.ts') } },
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve(__dirname, 'index.html') },
    },
    plugins: [react()],
  },
});
