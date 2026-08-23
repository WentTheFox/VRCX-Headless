/**
 * Checks whether upstream has cut a new VRCX release that this fork hasn't
 * synced to yet, using the exact convention CLAUDE.md's "Server/Docker
 * versioning" section already documents: the fork's own release tags are
 * real semver with the VRCX base as the *major* component (`v20260718.4.0`
 * for VRCX `2026.07.18`, fork build `4`). So "does a fork release exist for
 * the latest upstream VRCX version" is just "does any fork release tag start
 * with `v<latestVrcxVersion, dots stripped>.`".
 *
 * Used by both the `check-update` CLI command (for a human, or for the
 * scheduled CI workflow that opens an issue when a sync is needed) and the
 * `/api/update-check` HTTP route (for clients) — the comparison logic lives
 * in exactly one place so those three surfaces can't drift.
 */
import { URLSearchParams } from 'node:url';

import { githubGet } from './github-api.js';
import { readVersion } from './globals.js';
import { log } from './log.js';

const UPSTREAM_REPO = 'vrcx-team/VRCX';
const FORK_REPO = 'WentTheFox/VRCX-Headless';

// Upstream cuts a release roughly every few weeks (CLAUDE.md §6) — this just
// needs to avoid hammering GitHub's unauthenticated rate limit (60/hr/IP) on
// every client poll or CI run, not track changes in near-real-time.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** @type {{ result: Awaited<ReturnType<typeof computeUpdateStatus>>, at: number } | null} */
let cached = null;

/**
 * The label the scheduled CI workflow (task: daily check) searches for
 * before opening a new issue, so a sync that's still pending after several
 * days doesn't accumulate a duplicate issue on every run — one label
 * constant shared between "what to search for" and "what to tag it with".
 */
export const ISSUE_LABEL = 'upstream-sync-needed';

/**
 * Raw title/body (for `gh issue create --title --body`, or anything else
 * that wants the text directly) plus the pre-encoded `github.com/.../issues/
 * new?...` URL (for a UI that just wants a clickable link) — built from the
 * same two strings so they can't drift apart.
 * @param {string} latestVrcxVersion
 * @returns {{ title: string, body: string, url: string }}
 */
function buildIssueContent(latestVrcxVersion) {
    const title = `Sync needed: upstream VRCX ${latestVrcxVersion} has no fork release yet`;
    const body =
        `Upstream released VRCX ${latestVrcxVersion}, but there is no ` +
        `${FORK_REPO} release with a matching major version yet.\n\n` +
        `See CLAUDE.md's §6 "Upstream sync procedure" and §10 "Server/Docker versioning".`;
    const params = new URLSearchParams({ title, body });
    return {
        title,
        body,
        url: `https://github.com/${FORK_REPO}/issues/new?${params.toString()}`
    };
}

/**
 * @returns {Promise<{
 *   currentVrcxVersion: string,
 *   latestVrcxVersion: string,
 *   vrcxUpdateAvailable: boolean,
 *   forkReleaseAvailable: boolean,
 *   forkReleaseTag: string | null,
 *   issueTitle: string | null,
 *   issueBody: string | null,
 *   issueUrl: string | null
 * }>}
 */
async function computeUpdateStatus() {
    const currentVrcxVersion = readVersion();

    const latestRelease = await githubGet(
        `/repos/${UPSTREAM_REPO}/releases/latest`
    );
    const latestVrcxVersion = String(latestRelease.tag_name).replace(
        /^v/,
        ''
    );
    const vrcxUpdateAvailable = latestVrcxVersion !== currentVrcxVersion;

    let forkReleaseAvailable = true;
    let forkReleaseTag = null;
    if (vrcxUpdateAvailable) {
        const majorPrefix = `v${latestVrcxVersion.replaceAll('.', '')}.`;
        // Tags, not `/releases` — found live: this fork has never published
        // an actual GitHub Release object (§10's "cutting a release" is
        // `git tag` + `git push --tags`, which only triggers the Docker
        // publish workflow), so `/releases` always returns empty here and
        // would make this report a gap that doesn't exist on every single
        // check.
        const forkTags = await githubGet(
            `/repos/${FORK_REPO}/tags?per_page=100`
        );
        const match = forkTags.find((tag) =>
            String(tag.name).startsWith(majorPrefix)
        );
        forkReleaseAvailable = Boolean(match);
        forkReleaseTag = match?.name ?? null;
    }

    const needsIssue = vrcxUpdateAvailable && !forkReleaseAvailable;
    const issueContent = needsIssue
        ? buildIssueContent(latestVrcxVersion)
        : null;

    return {
        currentVrcxVersion,
        latestVrcxVersion,
        vrcxUpdateAvailable,
        forkReleaseAvailable,
        forkReleaseTag,
        issueTitle: issueContent?.title ?? null,
        issueBody: issueContent?.body ?? null,
        issueUrl: issueContent?.url ?? null
    };
}

/**
 * @param {{ force?: boolean }} [options] `force` bypasses the cache — the
 *   CI workflow (task: daily check) wants a fresh answer every run, not
 *   whatever an unrelated `serve` process happened to cache hours ago.
 * @returns {Promise<Awaited<ReturnType<typeof computeUpdateStatus>>>}
 */
export async function checkForUpdate({ force = false } = {}) {
    if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
        return cached.result;
    }
    const result = await computeUpdateStatus();
    cached = { result, at: Date.now() };
    return result;
}

/**
 * Best-effort variant for the HTTP route — a GitHub API hiccup shouldn't
 * turn into a 500 for every connected client, and stale-but-present cached
 * data is more useful than an error. Logs and falls back to the last good
 * cache entry (if any) on failure.
 * @returns {Promise<Awaited<ReturnType<typeof computeUpdateStatus>> | null>}
 */
export async function checkForUpdateSafe() {
    try {
        return await checkForUpdate();
    } catch (err) {
        log.warn('Update check failed', { message: err.message });
        return cached?.result ?? null;
    }
}
