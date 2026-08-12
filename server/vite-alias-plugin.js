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

import { aliases, resolveExtensions, resolveIndexFiles } from './aliases.js';

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
 * @returns {import('vite').Plugin}
 */
export function headlessAliasPlugin(aliasMapSource = aliases) {
    const aliasMap = new Map(
        Object.entries(aliasMapSource).map(([from, to]) => [
            path.join(repoRoot, from),
            path.join(repoRoot, to)
        ])
    );

    return {
        name: 'vrcx-headless-alias',
        enforce: 'pre',
        resolveId(source, importer) {
            if (!importer || !source.startsWith('.')) {
                return null;
            }
            const resolved = resolveLikeVite(
                path.resolve(path.dirname(importer), source)
            );
            if (!resolved) {
                return null;
            }
            const target = aliasMap.get(resolved);
            return target ?? null;
        }
    };
}
