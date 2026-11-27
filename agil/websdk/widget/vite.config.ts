import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const protocolDir = resolve(rootDir, '../../core/packages/protocol/src');
// These modules only declare schemas, constants and helpers. The protocol
// barrel otherwise evaluates their unused schema builders in every widget.
const sideEffectFreeProtocolModules = new Set(
  ['breakout', 'cluster', 'flows', 'liveness', 'poll', 'routing'].map((name) =>
    resolve(protocolDir, `${name}.ts`).split(sep).join('/'),
  ),
);

/**
 * `@agil/calls-widget` — self-contained ES library.
 *
 * Every dependency (including zod and `@agil/protocol`) is bundled, so the
 * resulting `dist/agil-calls-widget.js` can be dropped into any page together
 * with the emitted `dist/agil-calls-widget.css`.
 */
export default defineConfig({
  // Resolve emitted backgrounds and worker assets next to the host's widget module.
  base: './',
  resolve: {
    alias: {
      '@agil/protocol': resolve(protocolDir, 'index.ts'),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    copyPublicDir: false,
    lib: {
      // CSS + public API entry (tests stub CSS imports when loading it in Node).
      entry: resolve(rootDir, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'agil-calls-widget.js',
      cssFileName: 'agil-calls-widget',
    },
    rollupOptions: {
      // The lazy collaboration chunk statically imports shared helpers (`h`,
      // icons, protocol constants) from this entry. `allow-extension` keeps the
      // entry chunk as the module that other chunks import instead of Rollup
      // splitting the entry behind a facade, so the measured entry file stays
      // the real initial payload.
      preserveEntrySignatures: 'allow-extension',
      treeshake: {
        moduleSideEffects: (id) => !sideEffectFreeProtocolModules.has(id),
      },
      output: {
        // `livekit-client` is loaded lazily by `call/sfu-engine.ts`; keeping the
        // dynamic import as its own chunk means mesh-only rooms never download it.
        inlineDynamicImports: false,
        // Other lazy chunks (the whiteboard/annotation surface) go to a
        // subdirectory so the SFU QA bundle check keeps identifying the LiveKit
        // chunk by its `agil-livekit-*` name.
        chunkFileNames: (chunk) =>
          chunk.moduleIds.some((id) => id.includes('livekit-client'))
            ? 'agil-livekit-[hash].js'
            : 'chunks/[name]-[hash].js',
      },
    },
  },
});
