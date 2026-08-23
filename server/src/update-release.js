/**
 * The server-driven half of the desktop client's own updater (as opposed to
 * `update-check.js`, which answers a *different* question — "has upstream
 * VRCX cut a release we haven't synced to yet"). This module answers "is
 * there a published fork release matching *this server's own version*" —
 * the desktop client compares that against its own installed version and
 * updates itself to match, so a client never drifts ahead of or behind the
 * specific server it's connected to. See CLAUDE.md's desktop-updater
 * write-up for the full design.
 *
 * Deliberately an *exact tag* lookup (`/releases/tags/v<serverVersion>`),
 * not `/releases/latest` — the server's own version is the target, not
 * "whatever's newest on GitHub", since a client should track its connected
 * server, not the wider internet. A 404 here is expected and harmless right
 * after a version bump but before the draft release (CLAUDE.md §10) has
 * been published by hand — the client just reports "can't check right now"
 * rather than erroring.
 */
import { githubGet } from './github-api.js';
import { buildServerVersion, readForkVersion, readVersion } from './globals.js';

const FORK_REPO = 'WentTheFox/VRCX-Headless';

// The server's own version only changes on a restart after a redeploy, so a
// cached answer can live a while — this just needs to avoid a fresh GitHub
// API hit on every single desktop client connect/server-switch, which per
// CLAUDE.md's trigger design happens often.
const CACHE_TTL_MS = 30 * 60 * 1000;

/** @type {{ serverVersion: string, release: object | null, at: number } | null} */
let cached = null;

/**
 * @param {object} data raw GitHub release object
 * @returns {{ tag: string, htmlUrl: string, publishedAt: string, assets: Array<{name: string, contentType: string, size: number, digest: string | undefined, downloadUrl: string}> }}
 */
function normalizeRelease(data) {
    return {
        tag: data.tag_name,
        htmlUrl: data.html_url,
        publishedAt: data.published_at,
        assets: (data.assets ?? [])
            .filter((asset) => asset.state === 'uploaded')
            .map((asset) => ({
                name: asset.name,
                contentType: asset.content_type,
                size: asset.size,
                digest: asset.digest,
                downloadUrl: asset.browser_download_url
            }))
    };
}

/**
 * @param {{ force?: boolean }} [options] `force` bypasses the cache — used
 *   by the Settings page's manual "Retry" action (CLAUDE.md's desktop
 *   updater write-up) so a retry after a transient failure doesn't have to
 *   wait out the full TTL.
 * @returns {Promise<{ serverVersion: string, release: ReturnType<typeof normalizeRelease> | null }>}
 */
export async function getUpdateInfo({ force = false } = {}) {
    const serverVersion = buildServerVersion(readForkVersion(), readVersion());
    if (
        !force &&
        cached &&
        cached.serverVersion === serverVersion &&
        Date.now() - cached.at < CACHE_TTL_MS
    ) {
        return { serverVersion, release: cached.release };
    }

    let release = null;
    try {
        const data = await githubGet(
            `/repos/${FORK_REPO}/releases/tags/v${serverVersion}`
        );
        release = normalizeRelease(data);
    } catch {
        // Not published yet (draft, or the tag doesn't exist at all) or a
        // network hiccup — either way, "nothing to offer" rather than an
        // error the caller has to special-case.
    }

    cached = { serverVersion, release, at: Date.now() };
    return { serverVersion, release };
}
