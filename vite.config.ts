import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

/**
 * Jump labeller API (/api/…) for labeller.html, dev server only. The handler
 * is loaded through Vite, so edits to it apply without a restart.
 */
function labeller(options: { dataDir: string; labelsDir: string }): Plugin {
  return {
    name: 'flysight-labeller',
    apply: 'serve',
    configureServer(server) {
      let loaded: unknown;
      let api: (req: unknown, res: unknown) => Promise<void>;
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        server
          .ssrLoadModule('/src/labeller/devServer.ts')
          .then((mod) => {
            if (mod !== loaded) {
              loaded = mod;
              api = mod.createLabellerApi(options);
            }
            return api(req, res);
          })
          .catch(next);
      });
    },
  };
}

export default defineConfig({
  // GitHub Pages serves the project site under /flysight-viewer/
  base: process.env.GITHUB_ACTIONS ? '/flysight-viewer/' : '/',
  plugins: [
    // Jump labeller at /labeller.html, dev server only.
    labeller({
      dataDir: process.env.LABELLER_DATA ?? join(homedir(), 'flysight'),
      labelsDir: 'labels',
    }),
    // Installable app whose files are cached by a service worker, so it opens
    // and works offline once visited. New deploys are picked up on the next
    // online launch.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'FlySight Viewer',
        short_name: 'FlySight',
        description: 'Download and inspect FlySight 2 logs over Bluetooth',
        display: 'standalone',
        background_color: '#f4f5f7',
        theme_color: '#0b6bcb',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png}'],
      },
    }),
  ],
  test: {
    environment: 'node',
  },
});
