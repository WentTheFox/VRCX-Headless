/**
 * `server/src/group-instance-relay.js`'s `WebApiShim.Execute` wrap: relays
 * only successful `users/{id}/instances/groups` responses, parsed, and
 * leaves every other call (unrelated URL, or a failed one) untouched.
 */
import { describe, expect, it, vi } from 'vitest';

import {
    groupInstanceRelay,
    installGroupInstanceRelay
} from '../src/group-instance-relay.js';

/**
 * @param {(options: any) => Promise<{ Item1: number, Item2: string }>} execute
 */
function fakeWebApi(execute) {
    return { Execute: execute };
}

describe('installGroupInstanceRelay', () => {
    it('emits the parsed body for a successful group-instances call', async () => {
        const payload = { instances: [{ id: 'wrld_1' }], fetchedAt: 'now' };
        const webApi = fakeWebApi(async () => ({
            Item1: 200,
            Item2: JSON.stringify(payload)
        }));
        installGroupInstanceRelay(webApi);

        const seen = vi.fn();
        groupInstanceRelay.once('update', seen);

        await webApi.Execute({
            url: 'https://api.vrchat.cloud/api/1/users/usr_1/instances/groups'
        });

        expect(seen).toHaveBeenCalledWith(payload);
    });

    it('does not emit for an unrelated URL', async () => {
        const webApi = fakeWebApi(async () => ({
            Item1: 200,
            Item2: JSON.stringify({ ok: true })
        }));
        installGroupInstanceRelay(webApi);

        const seen = vi.fn();
        groupInstanceRelay.once('update', seen);

        await webApi.Execute({
            url: 'https://api.vrchat.cloud/api/1/auth/user'
        });

        expect(seen).not.toHaveBeenCalled();
    });

    it('does not emit for a failed call to the same endpoint', async () => {
        const webApi = fakeWebApi(async () => ({
            Item1: -1,
            Item2: 'boom'
        }));
        installGroupInstanceRelay(webApi);

        const seen = vi.fn();
        groupInstanceRelay.once('update', seen);

        await webApi.Execute({
            url: 'https://api.vrchat.cloud/api/1/users/usr_1/instances/groups'
        });

        expect(seen).not.toHaveBeenCalled();
    });

    it('does not throw and does not emit on a malformed body', async () => {
        const webApi = fakeWebApi(async () => ({
            Item1: 200,
            Item2: 'not json'
        }));
        installGroupInstanceRelay(webApi);

        const seen = vi.fn();
        groupInstanceRelay.once('update', seen);

        await expect(
            webApi.Execute({
                url: 'https://api.vrchat.cloud/api/1/users/usr_1/instances/groups'
            })
        ).resolves.toEqual({ Item1: 200, Item2: 'not json' });
        expect(seen).not.toHaveBeenCalled();
    });

    it('is idempotent — wrapping twice does not double-emit', async () => {
        const payload = { instances: [] };
        const webApi = fakeWebApi(async () => ({
            Item1: 200,
            Item2: JSON.stringify(payload)
        }));
        installGroupInstanceRelay(webApi);
        installGroupInstanceRelay(webApi);

        const seen = vi.fn();
        groupInstanceRelay.once('update', seen);

        await webApi.Execute({
            url: 'https://api.vrchat.cloud/api/1/users/usr_1/instances/groups'
        });

        expect(seen).toHaveBeenCalledTimes(1);
    });
});
