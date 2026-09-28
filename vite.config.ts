import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages serves the project site under /flysight-viewer/
  base: process.env.GITHUB_ACTIONS ? '/flysight-viewer/' : '/',
  test: {
    environment: 'node',
  },
});
