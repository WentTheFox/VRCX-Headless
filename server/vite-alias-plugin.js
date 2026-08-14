/**
 * Vite/Vitest plugin applying the same alias map as server/hooks.mjs.
 *
 * Vite's built-in `resolve.alias` matches on the *import specifier*, so it
 * cannot express "whatever `../stores` resolves to". The alias map is keyed by
 * resolved path precisely so it does not care how a module spells the import,
 * which is what keeps it stable across upstream refactors — hence this plugin.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import {
    aliases,
    packageAliases,
    resolveExtensions,
    resolveIndexFiles
} from './aliases.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

/**
 * @param {string} basePath
 * @returns {string | null}
 */
function resolveLikeVite(basePath) {
    for (const ext of resolveExtensions) {
        const candidate = basePath + ext;
        if (existsSync(candidate) && statSync(candidate).isFile()) {
            return candidate;
        }
    }
    if (existsSync(basePath) && statSync(basePath).isDirectory()) {
        for (const indexFile of resolveIndexFiles) {
            const candidate = path.join(basePath, indexFile);
            if (existsSync(candidate) && statSync(candidate).isFile()) {
                return candidate;
            }
        }
    }
    return null;
}

/**
 * @param {Record<string, string>} [aliasMapSource]
 * @param {Record<string, string>} [packageAliasMapSource] Bare-specifier
 *   aliases, kept as a separate parameter (not bundled into
 *   `aliasMapSource`) since the two maps key differently — repo-relative
 *   path vs. exact package name. Defaults to the server's own
 *   `packageAliases`; phase 4's client-web caller passes `{}` — a real
 *   browser needs none of `worker-timers`/`vue-sonner`/`noty` replaced,
 *   only Node does (found live: reusing this plugin unparameterized
 *   silently pulled `vue-sonner` in as the server's headless toast stub,
 *   which doesn't export the real `Toaster` component the client needs).
 * @returns {import('vite').Plugin}
 */
export function headlessAliasPlugin(
    aliasMapSource = aliases,
    packageAliasMapSource = packageAliases
) {
    const aliasMap = new Map(
        Object.entries(aliasMapSource).map(([from, to]) => [
            path.join(repoRoot, from),
            path.join(repoRoot, to)
        ])
    );

    const packageAliasMap = new Map(
        Object.entries(packageAliasMapSource).map(([from, to]) => [
            from,
            path.join(repoRoot, to)
        ])
    );

    return {
        name: 'vrcx-headless-alias',
        enforce: 'pre',
        resolveId(source, importer) {
            const packageAlias = packageAliasMap.get(source);
            if (packageAlias) {
                return packageAlias;
            }
            let basePath;
            if (path.isAbsolute(source)) {
                // Rolldown's own native resolve.alias (e.g. src/vite.config.js's
                // '@' -> src/) already runs before this plugin sees the
                // specifier, for any import that used one of those aliases —
                // unlike classic Rollup, it doesn't wait for a 'pre' JS
                // plugin. Found live: two real call sites import the
                // database barrel as '@/services/database' rather than a
                // relative path, and it arrived here already rewritten to
                // an absolute path (the '@/...' specifier itself was gone
                // by the time resolveId saw it), silently bypassing what
                // used to be a relative-specifiers-only check and pulling
                // in the real, unaliased barrel (and transitively
                // src/services/sqlite.js) instead.
                basePath = source;
            } else if (!importer || !source.startsWith('.')) {
                return null;
            } else {
                basePath = path.resolve(path.dirname(importer), source);
            }
            const resolved = resolveLikeVite(basePath);
            if (!resolved) {
                return null;
            }
            const target = aliasMap.get(resolved);
            return target ?? null;
        }
    };
}
