/**
 * Node test loader shim.
 *
 * `call/sfu-engine.ts` imports Vite's worker URL form
 * (`livekit-client/e2ee-worker?worker`), which Node cannot resolve. The worker
 * is only instantiated for SFU/E2EE sessions, so a stub module is enough for
 * the DOM-free widget tests.
 *
 * `module.register()` is used instead of `registerHooks()` so the tests also run
 * on the repository's minimum Node 20 (registerHooks landed in Node 22.15+).
 */
import { register } from 'node:module';

register('./worker-hooks.mjs', import.meta.url);
