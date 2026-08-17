import { resolve } from 'node:path';

import fs from 'node:fs';

import { defineConfig, loadEnv } from 'vite';
import { browserslistToTargets } from 'lightningcss';

import browserslist from 'browserslist';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import vueJsx from '@vitejs/plugin-vue-jsx';

import { clientDesktopAliases } from '../client-desktop/aliases.js';
import { clientWebAliases } from '../client-web/aliases.js';
import { headlessAliasPlugin } from '../server/vite-alias-plugin.js';
import { languageCodes } from './localization/locales';

/**
 * Vite plugin to remove legacy remixicon font files (eot, woff, ttf, svg)
 * from the build output, keeping only woff2. Saves ~4.5 MB.
 *
 * Chrome 144 picks woff2 from the multi-format @font-face src list and
 * never requests the other formats, so deleting them is safe.
 *
 * @returns {import('vite').Plugin}
 */
function remixiconWoff2Only() {
    return {
        name: 'remixicon-woff2-only',
        generateBundle(_, bundle) {
            for (const key of Object.keys(bundle)) {
                if (/remixicon\.(eot|ttf|svg|woff)$/.test(key)) {
                    delete bundle[key];
                }
            }
        }
    };
}

/**
 *
 * @param assetId
 */
function getAssetLanguage(assetId) {
    if (!assetId) return null;

    if (assetId.endsWith('.json')) {
        const language = assetId.split('.json')[0];

        if (languageCodes.includes(language)) return language;
    }

    const language =
        // Font assets, e.g., noto-sans-jp-regular.woff2 mapped to language code.
        {
            jp: 'ja',
            sc: 'zh-CN',
            tc: 'zh-TW',
            kr: 'ko'
        }[assetId.split('noto-sans-')[1]?.split('-')[0]];

    return language || null;
}

/**
 *
 * @param moduleId
 */
function getManualChunk(moduleId) {
    const basename = moduleId.split('/').pop();
    const language = getAssetLanguage(basename);
    if (!language) return;

    return `i18n/${language}`;
}

const defaultAssetName = '[name][extname]';

/**
 * @param {string} name
 */
function isFont(name) {
    return /\.(woff2?|ttf|otf|eot)$/.test(name);
}

/**
 *
 * @param {import('rolldown').PreRenderedAsset} assetInfo
 */
function getAssetFilename({ name }) {
    const language = getAssetLanguage(name);
    if (!language) return `assets/${defaultAssetName}`;

    if (isFont(name)) return 'assets/fonts/[name][extname]';
    return 'assets/i18n/[name][extname]';
}

/**
 * @param ConfigEnv configEnv
 * @returns {import('vite').UserConfig}
 */
export default defineConfig(({ mode }) => {
    const { SENTRY_AUTH_TOKEN: sentryAuthToken } = loadEnv(mode, process.cwd(), '');

    const buildAndUploadSourceMaps = !!sentryAuthToken;

    const version = fs.readFileSync(new URL('../Version', import.meta.url), 'utf-8').trim();

    const nightly = mode === 'development' || version.split('-').at(-1).length === 7;

    const isWeb = process.env.PLATFORM === 'web';
    // The Windows/CefSharp build (`PLATFORM=windows`) is out of scope for
    // this fork — it's never built here; only the Linux/Electron desktop
    // build is (which, despite the flag name, also runs on Windows OS —
    // see CLAUDE.md's "Desktop client OS support" note).
    const isLinuxDesktop = process.env.PLATFORM === 'linux';

    /** @type {import('vite').UserConfig} */
    return {
        base: '',
        // Found live: Vite resolves `publicDir` relative to `root` by
        // default (`<root>/public`), and `client-web/` — the web build's
        // root — has no `public/` of its own, so `copyPublicDir: true`
        // below silently copied nothing at all for that platform. The
        // symptom was exactly as confusing as a missing-asset bug gets:
        // every avatar in the friends list rendered as fully invisible
        // (not broken-image, not blank-but-present) because
        // `src/shared/utils/base/ui.js`'s user-avatar CSS `mask-image`
        // pointed at `images/masks/usercutout.svg`, which the SPA
        // fallback (server/src/http-server.js's `serveWebClient`) quietly
        // served `index.html` in place of — a masked element with a
        // failed/invalid mask resource renders as blank, not unmasked, so
        // there was no visual hint anything was even missing. Pinning
        // `publicDir` to the real `src/public` absolutely, independent of
        // which platform's root is active, fixes it for every build.
        publicDir: resolve(import.meta.dirname, 'public'),
        plugins: [
            // Must run before vue()/vueJsx() resolve anything — phase 4's
            // client-side seams (client-web/aliases.js), same mechanism the
            // server's Vitest config already uses (server/vite-alias-plugin.js).
            // Second arg {} : none of the server's package aliases apply —
            // worker-timers/vue-sonner/noty all work fine in a real
            // browser, unlike headless Node (see the plugin's own doc
            // comment for how this was found). Phase 5 reuses the same
            // plugin a third time for the Electron/Linux build
            // (client-desktop/aliases.js) — its package-alias surface is
            // identical to the web client's for the same reason (real
            // Electron renderer, not headless Node).
            isWeb && headlessAliasPlugin(clientWebAliases, {}),
            isLinuxDesktop && headlessAliasPlugin(clientDesktopAliases, {}),
            remixiconWoff2Only(),
            vue(),
            vueJsx({
                tsTransform: 'built-in'
            }),
            tailwindcss(),
            buildAndUploadSourceMaps &&
                import('@sentry/vite-plugin').then(({ sentryVitePlugin }) =>
                    sentryVitePlugin({
                        authToken: sentryAuthToken,
                        project: 'vrcx-web',
                        release: {
                            name: version
                        },
                        sourcemaps: {
                            assets: './build/html/**',
                            filesToDeleteAfterUpload: './build/html/**/*.js.map',
                            ignore: []
                        }
                    })
                )
        ],
        resolve: {
            alias: {
                '@': resolve(import.meta.dirname, '.')
            }
        },
        css: {
            transformer: 'lightningcss',
            lightningcss: {
                drafts: {
                    customMedia: true
                },
                errorRecovery: true,
                targets: browserslistToTargets(browserslist('Chrome 145'))
            }
        },
        optimizeDeps: {
            include: [
                'vue',
                'vue/jsx-runtime',
                'reka-ui',
                'pinia',
                'vue-i18n',
                'tailwindcss',
                'lucide-vue-next',
                '@vueuse/core',
                'vue-sonner',
                'dayjs'
            ]
        },
        define: {
            LINUX: JSON.stringify(process.env.PLATFORM === 'linux'),
            WINDOWS: JSON.stringify(process.env.PLATFORM === 'windows'),
            WEB: JSON.stringify(isWeb),
            VERSION: JSON.stringify(version),
            NIGHTLY: JSON.stringify(nightly)
        },
        server: isWeb
            ? {
                  // Vite's own dev port, not 9000 — the headless server's
                  // `serve` command already claims that one. `/api/*` and the
                  // `/api/stream` WS upgrade proxy through to a `serve`
                  // instance running alongside `npm run dev-web`; production
                  // is same-origin for real once `serve` serves this build's
                  // output directly (server/src/http-server.js).
                  port: 5173,
                  strictPort: true,
                  proxy: {
                      '/api': {
                          target: 'http://localhost:9000',
                          ws: true,
                          changeOrigin: true
                      }
                  }
              }
            : {
                  port: 9000,
                  strictPort: true
              },
        build: {
            target: 'chrome145',
            outDir: isWeb ? '../build/html-web' : '../build/html',
            license: true,
            emptyOutDir: true,
            copyPublicDir: true,
            reportCompressedSize: false,
            chunkSizeWarningLimit: 5000,
            sourcemap: buildAndUploadSourceMaps ? 'hidden' : false,
            assetsInlineLimit(filePath, content) {
                if (isFont(filePath)) return false;
                if (filePath.endsWith('.json')) return false;
                return content.length <= 40960;
            },
            rolldownOptions: {
                preserveEntrySignatures: false,
                input: isWeb
                    ? {
                          // No `vr` entry: VR overlay is a desktop-only
                          // capability (§1's ownership table) with no web
                          // client build at all.
                          index: resolve(import.meta.dirname, '../client-web/index.html')
                      }
                    : {
                          index: resolve(import.meta.dirname, './index.html'),
                          vr: resolve(import.meta.dirname, './vr.html')
                      },
                output: {
                    assetFileNames: getAssetFilename,
                    manualChunks: getManualChunk
                }
            }
        }
    };
});
