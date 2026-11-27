import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

/**
 * `@agil/calls-embed` — framework-free Web Component.
 *
 * Two artifacts are emitted:
 *  - `dist/agil-call-embed.js`      ESM (bundlers, `<script type="module">`);
 *  - `dist/agil-call-embed.iife.js` IIFE, global `AgilCallEmbed` (classic script tag).
 *
 * There are no runtime dependencies: the element, URL builder and postMessage
 * bridge are bundled as-is.
 */
export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
    minify: 'esbuild',
    copyPublicDir: false,
    lib: {
      entry: resolve(rootDir, 'src/index.ts'),
      name: 'AgilCallEmbed',
      formats: ['es', 'iife'],
      fileName: (format) =>
        format === 'es' ? 'agil-call-embed.js' : 'agil-call-embed.iife.js',
    },
    rollupOptions: {
      output: {
        // Rollup's ESM output keeps readable whitespace even with esbuild
        // minification; compact keeps both artifacts the same minimal size.
        compact: true,
      },
    },
  },
});
