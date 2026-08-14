/**
 * Fans out the VRChat pipeline's raw frames to connected `/api/stream`
 * clients (phase 3), verbatim — the server does no interpretation of them.
 * That matches CLAUDE.md's seam table for phase 4: the *client* subscribes
 * to the server's stream and calls the same `handlePipeline`
 * (`src/services/websocket.js`) itself, the same way the desktop app does;
 * the server's job is only to get the bytes there.
 *
 * ## Why a WebSocket wrapper, not editing `websocket.js`
 *
 * `src/services/websocket.js`'s pipeline connection is the *only* reachable
 * `new WebSocket()` call site in the whole server closure (true throughout
 * phase 2b, confirmed again here) — so tapping the global `WebSocket`
 * constructor sees every pipeline frame with no risk of catching unrelated
 * traffic. `installPipelineRelayPolyfill` runs after
 * `installWebSocketUserAgentPolyfill` (`server/src/globals.js`) and further
 * subclasses the already-patched constructor, adding one
 * `addEventListener('message', …)` in its own constructor.
 *
 * This does **not** touch `socket.onmessage = …`, which is how
 * `websocket.js:82` itself listens. Verified empirically (not assumed):
 * assigning `.onmessage` and calling `.addEventListener('message', …)` on
 * the same `WebSocket` instance are independent per the WHATWG event
 * handler IDL attribute semantics, and Node's implementation follows that —
 * both fire, neither replaces the other. That is what makes this a pure
 * *tap*: `websocket.js`'s own handling (parsing, `handlePipeline`,
 * reconnect-on-close) is completely undisturbed.
 *
 * Kept as its own polyfill/module rather than folded into the User-Agent
 * one in `globals.js` — one concern per polyfill, matching every other
 * entry there.
 */
import { EventEmitter } from 'node:events';

export const pipelineRelay = new EventEmitter();

export function installPipelineRelayPolyfill() {
    const CurrentWebSocket = globalThis.WebSocket;
    if (CurrentWebSocket?.__vrcxPipelineRelayPatched) {
        return;
    }
    class RelayingWebSocket extends CurrentWebSocket {
        constructor(url, options) {
            super(url, options);
            this.addEventListener('message', (event) => {
                pipelineRelay.emit('frame', event.data);
            });
        }
    }
    RelayingWebSocket.__vrcxPipelineRelayPatched = true;
    globalThis.WebSocket = RelayingWebSocket;
}
