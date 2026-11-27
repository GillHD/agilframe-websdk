/**
 * Vite resolves worker and CSS imports in the browser build. Headless tests
 * use local stubs for those imports.
 */
import * as module from 'node:module';
import { resolve } from './worker-hooks.mjs';

if (typeof module.registerHooks === 'function') {
  module.registerHooks({ resolve });
} else {
  module.register('./worker-hooks.mjs', import.meta.url);
}
