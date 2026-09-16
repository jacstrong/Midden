import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * Builds the nmap parsing worker as a self-contained classic (IIFE) script into src/generated/.
 * The app imports them as strings (`?raw`) and spawns them from data: URLs, which is the
 * one worker mechanism that works from file:// in Chromium, Firefox and WebKit alike
 * (Chromium refuses blob: workers on opaque file:// origins). Run before the app build.
 */
export default defineConfig({
  build: {
    lib: {
      entry: fileURLToPath(new URL('./src/workers/nmap.worker.ts', import.meta.url)),
      formats: ['iife'],
      name: 'MiddenWorker',
      fileName: () => 'nmap.worker.js',
    },
    outDir: 'src/generated',
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
  },
});
