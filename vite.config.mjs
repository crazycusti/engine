import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import process from 'process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Plugin to inject modulepreload hints for game module chunks.
 * That allows the browser to preload game modules in parallel during booting the game.
 * @returns {import('vite').Plugin} Vite plugin
 */
function gameModulePreloadPlugin() {
  return {
    name: 'game-module-preload',
    transformIndexHtml: {
      order: 'post',
      handler(html, { bundle }) {
        if (!bundle) {
          return html;
        }

        // Find all chunks that are game modules (from GameLoader)
        const gameModuleChunks = Object.values(bundle).filter(
          (chunk) =>
            chunk.type === 'chunk' &&
            chunk.facadeModuleId?.includes('/game/') &&
            chunk.facadeModuleId?.endsWith('/main.mjs')
        );

        if (gameModuleChunks.length === 0) {
          return html;
        }

        const preloadLinks = gameModuleChunks
          .map((chunk) => `\t\t<link rel="modulepreload" href="/${chunk.fileName}" />`)
          .join('\n');

        return html.replace('</head>', `\n${preloadLinks}\n\t</head>`);
      },
    },
  };
}

export default defineConfig(({ mode }) => ({
  root: 'public',
  publicDir: resolve(__dirname, 'public'),
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'public/index.html'),
      output: {
        entryFileNames: '[name]-[hash].js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: '[name]-[hash][extname]',
      },
    },
    copyPublicDir: true,
    sourcemap: mode !== 'production',
    chunkSizeWarningLimit: 1000,
    minify: mode === 'production' ? 'esbuild' : false,
  },
  plugins: [gameModulePreloadPlugin()],
  define: {
    '__BUILD_SIGNALING_URL__': JSON.stringify(
      process.env.VITE_SIGNALING_URL || '',
    ),
    '__BUILD_CDN_URL_PATTERN__': JSON.stringify(
      process.env.VITE_CDN_URL_PATTERN || '',
    ),
    '__BUILD_MODE__': JSON.stringify(mode),
    '__BUILD_TIMESTAMP__': JSON.stringify(new Date().toISOString()),
    '__BUILD_COMMIT_HASH__': JSON.stringify(process.env.WORKERS_CI_COMMIT_SHA || null),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'source'),
    },
  },
}));
