/**
 * Installs the compile-time globals that Vite injects into `src/**` via its
 * `define` block (see src/vite.config.js), plus the minimal `window` surface
 * the data layer touches.
 *
 * Keep this in sync with the `define` block on every upstream merge — see the
 * change-detection checklist in CLAUDE.md.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..'
);

/**
 * @returns {string} the contents of the repo-root `Version` file
 */
export function readVersion() {
    try {
        return readFileSync(path.join(repoRoot, 'Version'), 'utf8').trim();
    } catch {
        return '0.0.0';
    }
}

/**
 * Define `LINUX` / `WINDOWS` / `VERSION` / `NIGHTLY` as real globals so that
 * `src/**` — which references them as bare identifiers — can run under Node.
 *
 * Both platform flags are false on the server: it is neither the CEF/Windows
 * build nor the Electron/Linux build. `src/services/sqlite.js` branches only on
 * `LINUX`, so this selects the plain `SQLite.Execute` path; the shim in
 * ./shims/sqlite.js implements `ExecuteJson` too, so either value works.
 */
export function installGlobals() {
    if (globalThis.window === undefined) {
        globalThis.window = globalThis;
    }
    if (globalThis.LINUX === undefined) {
        globalThis.LINUX = false;
    }
    if (globalThis.WINDOWS === undefined) {
        globalThis.WINDOWS = false;
    }
    if (globalThis.VERSION === undefined) {
        globalThis.VERSION = readVersion();
    }
    if (globalThis.NIGHTLY === undefined) {
        globalThis.NIGHTLY = false;
    }
}
