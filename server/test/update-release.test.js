/**
 * Covers `update-release.js`'s `getUpdateInfo()` — the server-driven half
 * of the desktop client's own updater (distinct from `update-check.js`,
 * which tracks upstream VRCX sync freshness, not fork releases). Mocks
 * `node:https` the same way `update-check.test.js` does, since both go
 * through the shared `github-api.js` helper.
 */
import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:https', () => ({
    default: { get: vi.fn() }
}));

vi.mock('../src/globals.js', () => ({
    readVersion: () => '2026.07.18',
    readForkVersion: () => '11.0',
    readForkMinorVersion: (forkVersion) => forkVersion.split('.')[0],
    buildServerVersion: (forkVersion, vrcxVersion) =>
        `${vrcxVersion.replaceAll('.', '')}.${forkVersion}`
}));

import https from 'node:https';

import { getUpdateInfo } from '../src/update-release.js';

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

describe('getUpdateInfo', () => {
    it('returns the matching release when a tag exists for this server MINOR', async () => {
        mockGithubResponses({
            '/repos/WentTheFox/VRCX-Headless/releases': [
                {
                    tag_name: 'v20260718.11.0',
                    html_url:
                        'https://github.com/WentTheFox/VRCX-Headless/releases/tag/v20260718.11.0',
                    published_at: '2026-08-23T21:00:00Z',
                    assets: [
                        {
                            name: 'VRCX.Headless.Setup.20260718.11.0.win-x64.exe',
                            content_type: 'application/octet-stream',
                            size: 1234,
                            digest: 'sha256:abcdef',
                            state: 'uploaded',
                            browser_download_url:
                                'https://github.com/WentTheFox/VRCX-Headless/releases/download/v20260718.11.0/VRCX.Headless.Setup.20260718.11.0.win-x64.exe'
                        },
                        {
                            name: 'not-yet-uploaded.exe',
                            content_type: 'application/octet-stream',
                            size: 1,
                            state: 'starter',
                            browser_download_url: 'https://example.invalid/x'
                        }
                    ]
                }
            ]
        });

        const result = await getUpdateInfo({ force: true });

        expect(result.serverVersion).toBe('20260718.11.0');
        expect(result.release).not.toBeNull();
        expect(result.release.tag).toBe('v20260718.11.0');
        // only the uploaded asset should survive the filter
        expect(result.release.assets).toHaveLength(1);
        expect(result.release.assets[0]).toEqual({
            name: 'VRCX.Headless.Setup.20260718.11.0.win-x64.exe',
            contentType: 'application/octet-stream',
            size: 1234,
            digest: 'sha256:abcdef',
            downloadUrl:
                'https://github.com/WentTheFox/VRCX-Headless/releases/download/v20260718.11.0/VRCX.Headless.Setup.20260718.11.0.win-x64.exe'
        });
    });

    it('offers the newest PATCH under this server\'s MINOR even though the server itself is still on an older PATCH', async () => {
        // The running server reports 20260718.11.0 (mocked readForkVersion
        // above), but two client-only releases have shipped since without
        // anyone needing to redeploy the server — the client should be
        // offered the newest one, .2, not an exact match of .0.
        mockGithubResponses({
            '/repos/WentTheFox/VRCX-Headless/releases': [
                {
                    tag_name: 'v20260718.11.2',
                    html_url: 'https://example.invalid/2',
                    published_at: '2026-08-25T00:00:00Z',
                    assets: []
                },
                {
                    tag_name: 'v20260718.11.1',
                    html_url: 'https://example.invalid/1',
                    published_at: '2026-08-24T00:00:00Z',
                    assets: []
                },
                {
                    tag_name: 'v20260718.11.0',
                    html_url: 'https://example.invalid/0',
                    published_at: '2026-08-23T00:00:00Z',
                    assets: []
                },
                {
                    // a different MINOR (server change) must never be picked
                    tag_name: 'v20260718.12.0',
                    html_url: 'https://example.invalid/12',
                    published_at: '2026-08-26T00:00:00Z',
                    assets: []
                }
            ]
        });

        const result = await getUpdateInfo({ force: true });

        expect(result.serverVersion).toBe('20260718.11.0');
        expect(result.release.tag).toBe('v20260718.11.2');
    });

    it('reports no release when nothing has been published yet for this MINOR', async () => {
        mockGithubResponses({
            '/repos/WentTheFox/VRCX-Headless/releases': []
        });

        const result = await getUpdateInfo({ force: true });

        expect(result.serverVersion).toBe('20260718.11.0');
        expect(result.release).toBeNull();
    });

    it('caches the result and does not re-fetch within the TTL', async () => {
        mockGithubResponses({
            '/repos/WentTheFox/VRCX-Headless/releases': [
                {
                    tag_name: 'v20260718.11.0',
                    html_url: 'https://example.invalid',
                    published_at: '2026-08-23T21:00:00Z',
                    assets: []
                }
            ]
        });

        await getUpdateInfo({ force: true });
        await getUpdateInfo();

        expect(https.get).toHaveBeenCalledTimes(1);
    });
});
