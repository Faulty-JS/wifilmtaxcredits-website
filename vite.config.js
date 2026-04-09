import { defineConfig } from 'vite';
import { copyFileSync, statSync, readFileSync } from 'fs';
import { join } from 'path';

function siteAssetsPlugin() {
  return {
    name: 'site-assets-plugin',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();
        const [pathname] = req.url.split('?');
        if (pathname !== '/styles.css') return next();
        try {
          const css = readFileSync(join(process.cwd(), 'styles.css'));
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/css; charset=utf-8');
          res.end(css);
        } catch (e) {
          next();
        }
      });
    },
    buildEnd() {
      try {
        const src = join(process.cwd(), 'styles.css');
        const dest = join(process.cwd(), 'dist', 'styles.css');
        if (statSync(src).isFile()) copyFileSync(src, dest);
      } catch (e) {
        console.warn('styles.css copy failed:', e.message);
      }
    }
  };
}

export default defineConfig({
  publicDir: 'public',
  plugins: [siteAssetsPlugin()],
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
