import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig(({ mode }) => ({
  esbuild: {
    // Strip all console calls in production dedicated builds.
    drop: mode === 'production' ? ['console', 'debugger'] : [],
  },
  build: {
    // Keep frontend build artifacts; only overwrite dedicated entry/chunks.
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: false,
    ssr: resolve(__dirname, 'dedicated.mjs'),
    sourcemap: mode !== 'production',
    minify: mode === 'production' ? 'esbuild' : false,
    target: 'node20',
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        format: 'es',
        entryFileNames: 'dedicated.mjs',
        chunkFileNames: 'chunks/[name]-[hash].mjs',
      },
    },
  },
}));
