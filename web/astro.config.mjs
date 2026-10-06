// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// Deployed to GitHub Pages as a project site: https://florianditt.github.io/posidonia-watch/
export default defineConfig({
  site: 'https://florianditt.github.io',
  base: '/posidonia-watch',
  trailingSlash: 'always',
  output: 'static',
  vite: {
    plugins: [tailwindcss()],
    // MapLibre's main bundle is ~1.2 MB minified (~340 kB gzip) and only loads on the map page.
    build: { chunkSizeWarningLimit: 1600 },
    worker: { format: 'es' },
  },
});
