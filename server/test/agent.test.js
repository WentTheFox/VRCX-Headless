/**
 * `server/src/agent.js`'s request/response correlation over a fake
 * WebSocket — the real `ws` package's actual transport isn't under test
 * here, `dispatchRpc`-style unit coverage of the correlation logic is.
 */
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { desktopAgent } from '../src/agent.js';

/**
 * A minimal stand-in for a `ws` WebSocket — just enough surface for
 * `DesktopAgent` to drive: `readyState`/`OPEN`, `send`, `close`, and the
 * `on('message'|'close', ...)` API it actually calls.
 */
class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.OPEN = 1;
        this.readyState = 1;
        this.sent = [];
        this.closed = false;
    }

    send(data) {
        this.sent.push(JSON.parse(data));
    }

    close() {
        this.closed = true;
        this.readyState = 3;
        this.emit('close');
    }

    /**
     * Simulates the agent replying to the most recently sent request.
     * @param {{ ok: boolean, result?: any, error?: string }} response
     */
    reply(response) {
        const { requestId } = this.sent.at(-1);
        this.emit(
            'message',
            Buffer.from(JSON.stringify({ requestId, ...response }))
        );
    }
}

describe('desktopAgent', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        // Detach whatever the previous test left connected, so tests don't
        // leak state through the shared singleton.
        desktopAgent.socket?.removeAllListeners();
        desktopAgent.socket = null;
        vi.useRealTimers();
    });

    it('is not connected before anything attaches', () => {
        expect(desktopAgent.isConnected()).toBe(false);
    });

    it('rejects a call when no agent is connected', async () => {
        await expect(
            desktopAgent.call('AppApi', 'GetVersion', [])
        ).rejects.toThrow(/no desktop agent connected/i);
    });

    it('is connected once a socket attaches', () => {
        const socket = new FakeSocket();
        desktopAgent.attach(socket);
        expect(desktopAgent.isConnected()).toBe(true);
    });

    it('sends a correlated request and resolves on a matching reply', async () => {
        const socket = new FakeSocket();
        desktopAgent.attach(socket);

        const promise = desktopAgent.call('AppApi', 'GetVersion', []);
        expect(socket.sent).toHaveLength(1);
        expect(socket.sent[0]).toMatchObject({
            className: 'AppApi',
            methodName: 'GetVersion',
            args: []
        });
        expect(typeof socket.sent[0].requestId).toBe('string');

        socket.reply({ ok: true, result: '2026.07.18' });
        await expect(promise).resolves.toBe('2026.07.18');
    });

    it('rejects when the agent replies with ok:false', async () => {
        const socket = new FakeSocket();
        desktopAgent.attach(socket);

        const promise = desktopAgent.call('LogWatcher', 'Get', []);
        socket.reply({ ok: false, error: 'native call exploded' });
        await expect(promise).rejects.toThrow('native call exploded');
    });

    it('times out if the agent never replies', async () => {
        const socket = new FakeSocket();
        desktopAgent.attach(socket);

        const promise = desktopAgent.call('Discord', 'SetActive', [true]);
        const assertion = expect(promise).rejects.toThrow(/timed out/i);
        await vi.advanceTimersByTimeAsync(10_000);
        await assertion;
    });

    it('rejects in-flight calls when the socket closes', async () => {
        const socket = new FakeSocket();
        desktopAgent.attach(socket);

        const promise = desktopAgent.call('AppApi', 'GetVersion', []);
        socket.close();
        await expect(promise).rejects.toThrow(/disconnected/i);
        expect(desktopAgent.isConnected()).toBe(false);
    });

    it('replaces an older connection with a new one', () => {
        const first = new FakeSocket();
        const second = new FakeSocket();
        desktopAgent.attach(first);
        desktopAgent.attach(second);
        expect(first.closed).toBe(true);
        expect(desktopAgent.socket).toBe(second);
    });

    it('ignores messages with no matching pending request', () => {
        const socket = new FakeSocket();
        desktopAgent.attach(socket);
        expect(() =>
            socket.emit(
                'message',
                Buffer.from(JSON.stringify({ requestId: 'bogus', ok: true }))
            )
        ).not.toThrow();
    });

    it('ignores unparseable messages', () => {
        const socket = new FakeSocket();
        desktopAgent.attach(socket);
        expect(() =>
            socket.emit('message', Buffer.from('not json'))
        ).not.toThrow();
    });
});
