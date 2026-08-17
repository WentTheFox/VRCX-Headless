/**
 * Pins the comparison logic in `update-check.js` — the fork's own release
 * tags are real semver with the VRCX base as the major component
 * (`v20260718.4.0`), so "does a fork release exist for the latest upstream
 * version" is "does any fork tag start with `v<version, dots stripped>.`".
 * Mocks `node:https` rather than hitting the real GitHub API, both for
 * CI reliability and because `githubGet()` deliberately doesn't use `fetch`
 * (see its own doc comment — a real libuv crash on Windows CLI exits).
 */
import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:https', () => ({
    default: { get: vi.fn() }
}));

vi.mock('../src/globals.js', () => ({
    readVersion: () => '2026.07.18'
}));

import https from 'node:https';

import { checkForUpdate } from '../src/update-check.js';

/**
 * @param {Record<string, any>} responses keyed by request path
 */
function mockGithubResponses(responses) {
    https.get.mockImplementation((url, _options, callback) => {
        const path = new URL(url).pathname + new URL(url).search;
        const matchKey = Object.keys(responses).find((key) =>
            path.startsWith(key)
        );
        const body = responses[matchKey];
        const res = new EventEmitter();
        res.statusCode = body === undefined ? 404 : 200;
        res.statusMessage = 'OK';
        callback(res);
        res.emit('data', JSON.stringify(body ?? { message: 'Not found' }));
        res.emit('end');
        const req = new EventEmitter();
        return req;
    });
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('checkForUpdate', () => {
    it('reports no update when the latest release matches the current version', async () => {
        mockGithubResponses({
            '/repos/vrcx-team/VRCX/releases/latest': { tag_name: 'v2026.07.18' }
        });

        const result = await checkForUpdate({ force: true });

        expect(result).toEqual({
            currentVrcxVersion: '2026.07.18',
            latestVrcxVersion: '2026.07.18',
            vrcxUpdateAvailable: false,
            forkReleaseAvailable: true,
            forkReleaseTag: null,
            issueTitle: null,
            issueBody: null,
            issueUrl: null
        });
    });

    it('finds a matching fork tag by major-version prefix when an update exists', async () => {
        mockGithubResponses({
            '/repos/vrcx-team/VRCX/releases/latest': {
                tag_name: 'v2026.08.01'
            },
            '/repos/WentTheFox/VRCX-Headless/tags': [
                { name: 'v20260801.2.0' },
                { name: 'v20260801.1.0' },
                { name: 'v20260718.4.0' }
            ]
        });

        const result = await checkForUpdate({ force: true });

        expect(result.vrcxUpdateAvailable).toBe(true);
        expect(result.forkReleaseAvailable).toBe(true);
        expect(result.forkReleaseTag).toBe('v20260801.2.0');
        expect(result.issueUrl).toBeNull();
    });

    it('suggests opening an issue when no fork tag matches the new major version', async () => {
        mockGithubResponses({
            '/repos/vrcx-team/VRCX/releases/latest': {
                tag_name: 'v2026.08.01'
            },
            '/repos/WentTheFox/VRCX-Headless/tags': [
                { name: 'v20260718.4.0' },
                { name: 'v20260718.3.0' }
            ]
        });

        const result = await checkForUpdate({ force: true });

        expect(result.vrcxUpdateAvailable).toBe(true);
        expect(result.forkReleaseAvailable).toBe(false);
        expect(result.forkReleaseTag).toBeNull();
        expect(result.issueTitle).toContain('2026.08.01');
        expect(result.issueBody).toContain('2026.08.01');
        expect(result.issueUrl).toContain(
            'https://github.com/WentTheFox/VRCX-Headless/issues/new?'
        );
        expect(result.issueUrl).toContain('2026.08.01');
    });

    it('never matches a fork tag from a different major version (prefix, not substring)', async () => {
        mockGithubResponses({
            '/repos/vrcx-team/VRCX/releases/latest': {
                tag_name: 'v2026.08.01'
            },
            // v202608011.0.0 contains "20260801" as a substring but does NOT
            // start with the "v20260801." prefix -- must not match.
            '/repos/WentTheFox/VRCX-Headless/tags': [{ name: 'v202608011.0.0' }]
        });

        const result = await checkForUpdate({ force: true });

        expect(result.forkReleaseAvailable).toBe(false);
    });
});
