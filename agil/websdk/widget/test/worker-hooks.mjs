/** ESM loader hook used by register-loader.mjs (Node 20+). */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'livekit-client/e2ee-worker?worker') {
    return {
      url: new URL('./stubs/e2ee-worker.mjs', import.meta.url).href,
      shortCircuit: true,
    };
  }
  // Vite handles CSS imports in builds; Node tests only need a side-effect-free
  // module (the headless path never touches styles).
  if (specifier.endsWith('.css') || specifier.includes('.css?')) {
    return {
      url: new URL('./stubs/empty-css.mjs', import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
