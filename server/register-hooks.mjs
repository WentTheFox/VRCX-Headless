/**
 * Entry shim: `node --import ./server/register-hooks.mjs <script>`
 *
 * Registers the resolve hook (see ./hooks.mjs) and installs the browser globals
 * that `src/**` is compiled against by Vite. Both must happen before any module
 * under `src/` is imported, which is why this is an `--import` preload rather
 * than a normal import inside the app.
 */
import { register } from 'node:module';

import { installGlobals } from './src/globals.js';

installGlobals();
register('./hooks.mjs', import.meta.url);
