/**
 * The server-driven half of the desktop client's own updater (as opposed to
 * `update-check.js`, which answers a *different* question — "has upstream
 * VRCX cut a release we haven't synced to yet"). This module answers "what's
 * the newest published fork release compatible with *this server*" — the
 * desktop client compares that against its own installed version and
 * updates itself to match, so a client never drifts ahead of or behind the
 * specific server it's connected to. See CLAUDE.md's desktop-updater
 * write-up for the full design.
 *
 * "Compatible" means same MAJOR (VRCX base) and MINOR (server release) —
 * not an exact version match. CLAUDE.md's versioning scheme reserves MINOR
 * bumps for changes that need this server itself redeployed, and PATCH
 * bumps for client-only changes that don't; a running server's own PATCH
 * can therefore legitimately lag behind the newest one published under its
 * MINOR (nobody had to redeploy the server for a client-only release), and
 * clients should still be offered that newer PATCH. A MINOR mismatch is a
 * different situation entirely — it means the server itself was rebuilt —
 * and is handled the same way it always was: the client just checks again
 * against whatever MINOR the (new) server reports.
 *
 * Lists releases rather than looking up one exact tag, and picks the
 * highest PATCH whose tag starts with this server's `<major>.<minor>.`
 * prefix. A prefix with no match at all (nothing published yet under this
 * MINOR — expected right after a version bump, before the draft release,
 * CLAUDE.md §10, has been published by hand) is expected and harmless; the
 * client just reports "can't check right now" rather than erroring.
 */
import { githubGet } from './github-api.js';
import {
    buildServerVersion,
    readForkMinorVersion,
    readForkVersion,
    readVersion
} from './globals.js';

const FORK_REPO = 'WentTheFox/VRCX-Headless';

// The server's own version only changes on a restart after a redeploy, so a
// cached answer can live a while — this just needs to avoid a fresh GitHub
// API hit on every single desktop client connect/server-switch, which per
// CLAUDE.md's trigger design happens often.
const CACHE_TTL_MS = 30 * 60 * 1000;

/** @type {{ prefix: string, release: object | null, at: number } | null} */
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
 * @param {string} prefix e.g. `v20260718.20.`
 * @returns {Promise<object | null>} the raw GitHub release object with the
 *   highest PATCH matching `prefix`, or `null` if none do
 */
async function findLatestReleaseForMinor(prefix) {
    // GitHub's default page size (30) comfortably covers "every release
    // ever published under one MINOR" for the foreseeable release cadence;
    // an unauthenticated request also can't see drafts, so an
    // in-progress-but-unpublished release for this MINOR is correctly
    // invisible here too, same as the old exact-tag lookup's 404 case.
    const releases = await githubGet(`/repos/${FORK_REPO}/releases`);
    let best = null;
    let bestPatch = -1;
    for (const release of releases) {
        const tag = String(release.tag_name ?? '');
        if (!tag.startsWith(prefix)) {
            continue;
        }
        const patch = Number.parseInt(tag.slice(prefix.length), 10);
        if (Number.isFinite(patch) && patch > bestPatch) {
            best = release;
            bestPatch = patch;
        }
    }
    return best;
}

/**
 * @param {{ force?: boolean }} [options] `force` bypasses the cache — used
 *   by the Settings page's manual "Retry" action (CLAUDE.md's desktop
 *   updater write-up) so a retry after a transient failure doesn't have to
 *   wait out the full TTL.
 * @returns {Promise<{ serverVersion: string, release: ReturnType<typeof normalizeRelease> | null }>}
 */
export async function getUpdateInfo({ force = false } = {}) {
    const forkVersion = readForkVersion();
    const vrcxVersion = readVersion();
    const serverVersion = buildServerVersion(forkVersion, vrcxVersion);
    const prefix = `v${vrcxVersion.replaceAll('.', '')}.${readForkMinorVersion(forkVersion)}.`;

    if (
        !force &&
        cached &&
        cached.prefix === prefix &&
        Date.now() - cached.at < CACHE_TTL_MS
    ) {
        return { serverVersion, release: cached.release };
    }

    let release = null;
    try {
        const data = await findLatestReleaseForMinor(prefix);
        if (data) {
            release = normalizeRelease(data);
        }
    } catch {
        // Network hiccup — "nothing to offer" rather than an error the
        // caller has to special-case.
    }

    cached = { prefix, release, at: Date.now() };
    return { serverVersion, release };
}
