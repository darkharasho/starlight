import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    // Bundle the workspace packages: they're symlinks in node_modules, which
    // electron-builder can't package. Their own deps (frida stays external,
    // and is a direct dependency of this app) follow.
    plugins: [externalizeDepsPlugin({ exclude: ['@starlight/engine', '@starlight/ct-importer', '@starlight/catalog'] })],
    build: { outDir: 'out/main', lib: { entry: resolve(__dirname, 'src/main/index.ts') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      lib: {
        entry: resolve(__dirname, 'src/preload/index.ts'),
        // Sandboxed preload scripts must be CJS — Electron's sandbox bundle
        // does not support ES modules. Emit a single index.cjs.
        formats: ['cjs'],
        fileName: () => 'index.cjs',
      },
      rollupOptions: { output: { format: 'cjs' } },
    },
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
