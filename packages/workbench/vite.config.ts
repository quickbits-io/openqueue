import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: resolve(dirname, 'src/ui'),
  base: './',
  server: {
    port: 5678,
  },
  build: {
    outDir: resolve(dirname, 'dist/ui'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(dirname, 'src/ui/index.html'),
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
  resolve: {
    alias: [
      { find: '@/core', replacement: resolve(dirname, 'src/core') },
      { find: '@', replacement: resolve(dirname, 'src/ui') },
    ],
  },
});
