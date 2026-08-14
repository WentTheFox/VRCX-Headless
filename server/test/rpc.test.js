/**
 * The generic `/api/rpc` dispatcher (`server/src/rpc.js`) against fake
 * `db`/`config` targets — the dispatch mechanism itself is what's under
 * test, not `database.js`/`config.js`'s real methods (covered by
 * `db.test.js`).
 */
import { describe, expect, it } from 'vitest';

import { dispatchRpc } from '../src/rpc.js';

/**
 * @returns {import('../src/db.js').DatabaseHandle}
 */
function fakeHandle() {
    return /** @type {any} */ ({
        database: {
            async echo(value) {
                return value;
            },
            async explode() {
                throw new Error('boom');
            }
        },
        configRepository: {
            async getString(key, fallback) {
                return key === 'known' ? 'value' : fallback;
            }
        }
    });
}

describe('dispatchRpc', () => {
    it('dispatches to the db target and returns the result', async () => {
        const result = await dispatchRpc(fakeHandle(), {
            target: 'db',
            method: 'echo',
            args: ['hello']
        });
        expect(result).toEqual({ ok: true, result: 'hello' });
    });

    it('dispatches to the config target', async () => {
        const result = await dispatchRpc(fakeHandle(), {
            target: 'config',
            method: 'getString',
            args: ['known', '']
        });
        expect(result).toEqual({ ok: true, result: 'value' });
    });

    it('normalises an undefined return to null', async () => {
        const handle = fakeHandle();
        handle.database.noop = async () => undefined;
        const result = await dispatchRpc(handle, {
            target: 'db',
            method: 'noop',
            args: []
        });
        expect(result).toEqual({ ok: true, result: null });
    });

    it('treats a missing args array as no arguments', async () => {
        const result = await dispatchRpc(fakeHandle(), {
            target: 'db',
            method: 'echo'
        });
        // echo(undefined) returns undefined, normalised to null (see the
        // "normalises an undefined return to null" case above).
        expect(result).toEqual({ ok: true, result: null });
    });

    it('returns ok:false instead of throwing when the method throws', async () => {
        const result = await dispatchRpc(fakeHandle(), {
            target: 'db',
            method: 'explode',
            args: []
        });
        expect(result).toEqual({ ok: false, error: 'boom' });
    });

    it('rejects an unknown target', async () => {
        const result = await dispatchRpc(fakeHandle(), {
            target: 'webapi',
            method: 'echo',
            args: []
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/unknown rpc target/i);
    });

    it('rejects an unknown method', async () => {
        const result = await dispatchRpc(fakeHandle(), {
            target: 'db',
            method: 'doesNotExist',
            args: []
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/unknown rpc method/i);
    });

    it('rejects non-function properties like constructor', async () => {
        const result = await dispatchRpc(fakeHandle(), {
            target: 'db',
            method: 'constructor',
            args: []
        });
        expect(result.ok).toBe(false);
    });

    it('rejects a non-string method', async () => {
        const result = await dispatchRpc(fakeHandle(), {
            target: 'db',
            method: 42,
            args: []
        });
        expect(result).toEqual({
            ok: false,
            error: 'RPC method must be a string'
        });
    });
});
