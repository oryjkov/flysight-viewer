import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages serves the project site under /flysight-viewer/
  base: process.env.GITHUB_ACTIONS ? '/flysight-viewer/' : '/',
  plugins: [
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
