#!/usr/bin/env node
/**
 * Guards against dependency drift between server/package.json and the root
 * package.json.
 *
 * The server declares its own runtime dependencies so the Docker image can be
 * built from a small manifest instead of installing the root's ~100 dev
 * dependencies (electron, vite, the whole Vue toolchain) under QEMU. The cost
 * of that is two places to state a version — and if they drift, the container
 * silently runs a different Vue/Pinia than the client is built against.
 *
 * Run by CI. Exits non-zero with an explanation on any mismatch.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..'
);

/**
 * @param {string} relativePath
 * @returns {any}
 */
function readManifest(relativePath) {
    return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

const root = readManifest('package.json');
const server = readManifest('server/package.json');

const rootDeps = { ...root.dependencies, ...root.devDependencies };
const serverDeps = server.dependencies ?? {};

/** @type {string[]} */
const problems = [];
/** @type {string[]} */
const serverOnly = [];

for (const [name, range] of Object.entries(serverDeps)) {
    const rootRange = rootDeps[name];
    if (rootRange === undefined) {
        serverOnly.push(`${name}@${range}`);
        continue;
    }
    if (rootRange !== range) {
        problems.push(
            `  ${name}: server declares ${range}, root declares ${rootRange}`
        );
    }
}

if (serverOnly.length > 0) {
    console.log(
        `Server-only dependencies (not used by the client build): ${serverOnly.join(', ')}`
    );
}

if (problems.length > 0) {
    console.error(
        'Dependency drift between server/package.json and package.json:\n' +
            problems.join('\n') +
            '\n\nThe server and the client must run the same versions. Update whichever ' +
            'is stale, or the published container will not match the app it serves.'
    );
    process.exit(1);
}

console.log(
    `server/package.json: ${Object.keys(serverDeps).length} dependencies, all consistent with the root manifest.`
);
