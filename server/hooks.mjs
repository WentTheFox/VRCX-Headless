/**
 * Node ESM resolve hook.
 *
 * Two jobs, both in service of the "never edit `src/**`" invariant:
 *
 *   1. Emulate Vite's resolver, so VRCX's extensionless / directory imports
 *      (`from '../database'`) work under plain Node.
 *   2. Apply the alias map in ./aliases.js, swapping browser-only modules for
 *      headless stubs at resolution time.
 *
 * It also forces `format: 'module'` for everything under `src/`, because the
 * root package.json has no `"type": "module"` and Node would otherwise parse
 * those ESM files as CommonJS.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    aliases,
    packageAliases,
    resolveExtensions,
    resolveIndexFiles
} from './aliases.js';

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
);
const srcRoot = path.join(repoRoot, 'src');

/** Alias map with absolute, normalised keys. */
const aliasMap = new Map(
    Object.entries(aliases).map(([from, to]) => [
        path.join(repoRoot, from),
        path.join(repoRoot, to)
    ])
);

/** Bare npm specifier -> absolute shim path. */
const packageAliasMap = new Map(
    Object.entries(packageAliases).map(([from, to]) => [
        from,
        path.join(repoRoot, to)
    ])
);

/**
 * Resolve a path the way Vite would: exact file, then with extensions, then as
 * a directory index.
 * @param {string} basePath absolute, extension-less or exact path
 * @returns {string | null} absolute path to an existing file
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
 * @param {string} specifier
 * @param {{ parentURL?: string }} context
 * @param {Function} nextResolve
 */
export async function resolve(specifier, context, nextResolve) {
    const packageAlias = packageAliasMap.get(specifier);
    if (packageAlias) {
        return {
            url: pathToFileURL(packageAlias).href,
            shortCircuit: true
        };
    }

    if (
        specifier.startsWith('./') ||
        specifier.startsWith('../') ||
        specifier.startsWith('/')
    ) {
        const parentPath = context.parentURL?.startsWith('file:')
            ? fileURLToPath(context.parentURL)
            : path.join(process.cwd(), 'index.js');

        const requested = path.resolve(path.dirname(parentPath), specifier);
        const resolved = resolveLikeVite(requested);

        if (resolved) {
            const target = aliasMap.get(resolved) ?? resolved;
            return {
                url: pathToFileURL(target).href,
                // `src/**` is ESM-by-convention but lives under a package.json
                // with no "type" field, so Node needs to be told explicitly.
                format: target.startsWith(srcRoot) ? 'module' : undefined,
                shortCircuit: true
            };
        }
    }

    return nextResolve(specifier, context);
}
