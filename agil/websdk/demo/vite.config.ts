import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const serverTarget = process.env.AGIL_SERVER_URL ?? 'http://localhost:8787';

/**
 * Local examples (port 5173).
 *
 * embed.html is the
 * full-screen iframe widget. Dev proxies let the demo talk to the API server on
 * 8787 without CORS surprises; a production build is served by that server.
 */
export default defineConfig({
  plugins: [{
    name: 'wiki-renderer-dev-path',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.url === '/wiki/render.js') request.url = '/src/wiki-render.ts';
        next();
      });
    },
  }],
  resolve: {
    alias: {
      '@agil/protocol': resolve(rootDir, '../../core/packages/protocol/src/index.ts'),
      '@agil/calls-widget': resolve(rootDir, '../widget/src/index.ts'),
      '@agil/calls-sdk': resolve(rootDir, '../sdk/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': { target: serverTarget, changeOrigin: true },
      '/ws': { target: serverTarget.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
      '/sdk': { target: serverTarget, changeOrigin: true },
      '/widget': { target: serverTarget, changeOrigin: true },
      '/docs': { target: serverTarget, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: (entry) => entry.name === 'wiki-render' ? 'wiki/render.js' : 'assets/[name]-[hash].js',
      },
      input: {
        index: resolve(rootDir, 'index.html'),
        embed: resolve(rootDir, 'embed.html'),
        live: resolve(rootDir, 'live.html'),
        'custom-ui': resolve(rootDir, 'custom-ui.html'),
        'wiki-render': resolve(rootDir, 'src/wiki-render.ts'),
      },
    },
  },
});
