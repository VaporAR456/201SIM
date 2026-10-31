import { defineConfig } from 'vite';

// base './' so the build works from any GitHub Pages sub-path
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
