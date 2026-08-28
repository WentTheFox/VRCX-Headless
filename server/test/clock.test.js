/**
 * `server/src/shims/clock.js` — the server-side override of
 * `src/shared/utils/clock.js` that bounds `src/stores/activity.js`'s
 * still-open self-session fill to desktop-agent connectivity instead of the
 * live wall clock. See that shim's own doc comment for the bug this fixes.
 */
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { desktopAgent } from '../src/agent.js';
import { now } from '../src/shims/clock.js';

class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.OPEN = 1;
        this.readyState = 1;
    }

    send() {}

    close() {
        this.readyState = 3;
        this.emit('close');
    }
}

describe('server clock shim', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        desktopAgent.socket?.removeAllListeners();
        desktopAgent.socket = null;
        vi.useRealTimers();
    });

    it('advances with the wall clock while a desktop agent is connected', () => {
        const socket = new FakeSocket();
        desktopAgent.attach(socket);
        const t0 = now();
        vi.advanceTimersByTime(30_000);
        expect(now()).toBe(t0 + 30_000);
    });

    it('stops advancing once the desktop agent disconnects', () => {
        const socket = new FakeSocket();
        desktopAgent.attach(socket);
        vi.advanceTimersByTime(2_000);
        socket.close();
        const frozenAt = now();
        vi.advanceTimersByTime(24 * 60 * 60 * 1000);
        expect(now()).toBe(frozenAt);
    });
});
