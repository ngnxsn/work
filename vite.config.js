import { defineConfig } from 'vite';

export default defineConfig({
  // relative asset paths, so the build works at username.github.io/<repo>/ and on a custom domain alike
  base: './',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 800, // three.js alone is ~600 kB unminified
  },
});
