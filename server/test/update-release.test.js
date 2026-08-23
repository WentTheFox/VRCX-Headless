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
    readForkVersion: () => '11',
    buildServerVersion: (forkVersion, vrcxVersion) =>
        `${vrcxVersion.replaceAll('.', '')}.${forkVersion}.0`
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
    it('returns the matching release when a tag exists for this server version', async () => {
        mockGithubResponses({
            '/repos/WentTheFox/VRCX-Headless/releases/tags/v20260718.11.0': {
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

    it('reports no release when the tag has not been published yet (draft, or not tagged at all)', async () => {
        mockGithubResponses({});

        const result = await getUpdateInfo({ force: true });

        expect(result.serverVersion).toBe('20260718.11.0');
        expect(result.release).toBeNull();
    });

    it('caches the result and does not re-fetch within the TTL', async () => {
        mockGithubResponses({
            '/repos/WentTheFox/VRCX-Headless/releases/tags/v20260718.11.0': {
                tag_name: 'v20260718.11.0',
                html_url: 'https://example.invalid',
                published_at: '2026-08-23T21:00:00Z',
                assets: []
            }
        });

        await getUpdateInfo({ force: true });
        await getUpdateInfo();

        expect(https.get).toHaveBeenCalledTimes(1);
    });
});
