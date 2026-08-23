/**
 * Shared GitHub REST API helper — extracted from `update-check.js` so
 * `update-release.js` (server-driven desktop updater) doesn't duplicate it.
 */
import https from 'node:https';

const GITHUB_API = 'https://api.github.com';

/**
 * Plain `node:https`, deliberately not `fetch` — a CLI invocation calls
 * `process.exit()` right after this resolves, and fetch's (undici's) pooled
 * keep-alive socket still mid-close at that point crashes Node with a
 * libuv assertion on Windows (confirmed live: `info` and every other CLI
 * command are unaffected, since none of them open an outbound HTTP
 * connection at all — this is the only one that does). `serve`'s long-lived
 * process would never hit it either way, since nothing forces an exit
 * there, but there's no reason to carry two different HTTP call styles for
 * one code path.
 * @param {string} path
 * @returns {Promise<any>}
 */
export function githubGet(path) {
    return new Promise((resolve, reject) => {
        const req = https.get(
            `${GITHUB_API}${path}`,
            {
                headers: {
                    Accept: 'application/vnd.github+json',
                    'User-Agent': 'vrcx-headless-update-check'
                }
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        reject(
                            new Error(
                                `GitHub API ${path} returned ${res.statusCode} ${res.statusMessage}`
                            )
                        );
                        return;
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch (err) {
                        reject(err);
                    }
                });
            }
        );
        req.on('error', reject);
    });
}
