import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

/**
 * Dual build:
 *  - `dist/agil-calls-sdk.js` — ESM, widget bundled inside;
 *  - `dist/agil-calls.js`     — IIFE, global `AGILCalls`, self-contained
 *    (widget + protocol + zod + injected CSS).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@agil/protocol': resolve(rootDir, '../../core/packages/protocol/src/index.ts'),
      '@agil/calls-widget': resolve(rootDir, '../widget/src/index.ts'),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    copyPublicDir: false,
    lib: {
      entry: resolve(rootDir, 'src/index.ts'),
      name: 'AGILCalls',
      formats: ['es', 'iife'],
      fileName: (format) => (format === 'es' ? 'agil-calls-sdk.js' : 'agil-calls.js'),
      cssFileName: 'agil-calls',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        extend: true,
      },
    },
  },
});
