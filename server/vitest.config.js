import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

import { headlessAliasPlugin } from './vite-alias-plugin.js';

const repoRoot = resolve(import.meta.dirname, '..');

export default defineConfig({
    // Vitest resolves through Vite, not through server/hooks.mjs, so the alias
    // map is applied by a plugin instead. Both read server/aliases.js, so the
    // two resolution paths cannot drift.
    plugins: [headlessAliasPlugin()],
    define: {
        NIGHTLY: JSON.stringify(false),
        WINDOWS: JSON.stringify(false),
        LINUX: JSON.stringify(false),
        VERSION: JSON.stringify('test')
    },
    test: {
        globals: true,
        environment: 'node',
        setupFiles: [resolve(import.meta.dirname, 'test/setup.js')],
        include: ['server/**/*.{test,spec}.js'],
        root: repoRoot
    },
    resolve: {
        alias: {
            '@': resolve(repoRoot, 'src')
        }
    }
});
