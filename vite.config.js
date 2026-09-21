import { defineConfig } from 'vite';

export default defineConfig({
  // The Pages project serves the repo root with no build step, so robots.txt,
  // sitemap.xml and 404.html live at the root rather than in a public dir that
  // only a build would copy.
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'esbuild',
    cssMinify: true,
    rollupOptions: {
      input: { main: './index.html' },
      output: {
        assetFileNames: 'assets/[name]-[hash][extname]',
        entryFileNames: 'assets/[name]-[hash].js'
      }
    }
  }
});
