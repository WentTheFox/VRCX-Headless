/**
 * Vitest setup for the server suite.
 *
 * Under the CLI this work is done by server/register-hooks.mjs; vitest has its
 * own module pipeline, so the browser globals are installed here instead. The
 * compile-time flags (LINUX/WINDOWS/VERSION/NIGHTLY) come from the `define`
 * block in server/vitest.config.js, matching how Vite builds `src/**`.
 */
import { installGlobals } from '../src/globals.js';

installGlobals();
