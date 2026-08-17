/**
 * Tracks the phase 5 desktop agent connection — at most one at a time, the
 * same single-account/single-process simplifying assumption CLAUDE.md §9
 * already documents for the VRChat connection itself. A new connection
 * replaces an older one (logged as a warning, not an error) rather than
 * fanning out to several, matching how `/api/login` already treats a
 * re-login.
 *
 * The wire shape mirrors `src-electron`'s own IPC dispatcher —
 * `(className, methodName, args) → result` — just carried over a WebSocket
 * instead of Electron's `ipcMain`/`ipcRenderer`. `server/src/globals.js`'s
 * `AppApi`/`LogWatcher`/`Discord`/`AssetBundleManager` polyfills call
 * `desktopAgent.call(...)` when a client is connected, falling back to their
 * existing no-op behaviour otherwise — this module's only job is the
 * request/response correlation over that one connection.
 *
 * Extends `EventEmitter` solely to emit `'attach'`: real `src/**` call sites
 * (e.g. `discordPresence.js`'s `setIsDiscordActive`) often guard a forwarded
 * call behind "only if this differs from what we last told the native side"
 * — a private, unreachable flag whose value has nothing to do with which
 * *agent* is actually attached. When a new agent replaces a dead one, that
 * flag is still whatever it was, so the call gets silently skipped and the
 * new agent's own native object never learns the real state. Found live
 * (2026-08-17): Discord.SetActive(true) never reached a second, reconnected
 * agent, even though SetAssets kept arriving every tick — the native side's
 * RichPresence client never got created because its `_active` flag was
 * never flipped. `createAgentAwarePolyfill` (`server/src/globals.js`)
 * listens for `'attach'` and replays each method's last-forwarded args to
 * the new agent, bypassing the stale upstream guard entirely rather than
 * trying to reach into a store closure we don't own.
 */
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

import { log } from './log.js';

const CALL_TIMEOUT_MS = 10_000;

class DesktopAgent extends EventEmitter {
    constructor() {
        super();
        /** @type {import('ws').WebSocket | null} */
        this.socket = null;
        /** @type {Map<string, { resolve: (value: any) => void, reject: (err: Error) => void, timer: NodeJS.Timeout }>} */
        this.pending = new Map();
    }

    /**
     * @returns {boolean}
     */
    isConnected() {
        return this.socket !== null && this.socket.readyState === this.socket.OPEN;
    }

    /**
     * @param {import('ws').WebSocket} socket
     */
    attach(socket) {
        if (this.socket) {
            log.warn('Desktop agent replaced by a new connection');
            this.socket.close();
        }
        this.socket = socket;
        socket.on('message', (data) => this.#handleMessage(data));
        socket.on('close', () => {
            if (this.socket === socket) {
                this.socket = null;
            }
            this.#rejectAllPending(new Error('Desktop agent disconnected'));
        });
        this.emit('attach');
    }

    /**
     * @param {import('node:buffer').Buffer | ArrayBuffer | Buffer[]} data
     */
    #handleMessage(data) {
        /** @type {{ requestId?: unknown, ok?: unknown, result?: unknown, error?: unknown }} */
        let message;
        try {
            message = JSON.parse(data.toString());
        } catch {
            return;
        }
        const { requestId, ok, result, error } = message;
        if (typeof requestId !== 'string') {
            return;
        }
        const pending = this.pending.get(requestId);
        if (!pending) {
            return;
        }
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        if (ok) {
            pending.resolve(result);
        } else {
            pending.reject(
                new Error(typeof error === 'string' ? error : 'Agent call failed')
            );
        }
    }

    /**
     * @param {Error} err
     */
    #rejectAllPending(err) {
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(err);
        }
        this.pending.clear();
    }

    /**
     * @param {string} className
     * @param {string} methodName
     * @param {any[]} args
     * @returns {Promise<any>}
     */
    call(className, methodName, args) {
        if (!this.isConnected()) {
            return Promise.reject(new Error('No desktop agent connected'));
        }
        const requestId = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(
                    new Error(
                        `Desktop agent call timed out: ${className}.${methodName}`
                    )
                );
            }, CALL_TIMEOUT_MS);
            this.pending.set(requestId, { resolve, reject, timer });
            this.socket.send(
                JSON.stringify({ requestId, className, methodName, args })
            );
        });
    }
}

export const desktopAgent = new DesktopAgent();
