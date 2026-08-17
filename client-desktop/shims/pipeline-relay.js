/**
 * Routes the pipeline WebSocket through the headless server instead of
 * straight to VRChat, mirroring client-web/bootstrap.js's own
 * `AppDebug.websocketDomain` override — but the desktop renderer has no
 * session cookie for the server's origin and a raw `new WebSocket()` can't
 * attach the `Authorization` header the server's `/api/stream` upgrade
 * requires, so the actual connection is opened in the main process (which
 * already holds the server token for RPC, see src-electron/main.js's
 * `vrcx-stream-connect`/`vrcx-stream-close` handlers) and relayed here as a
 * WebSocket-shaped object. `src/services/websocket.js`'s `connectWebSocket()`
 * only ever touches `.onopen`/`.onclose`/`.onerror`/`.onmessage`/`.close()`,
 * so that's all this needs to implement.
 *
 * Found live (2026-08-17): without this, the desktop renderer opened its
 * *own* separate, direct pipeline connection to VRChat (unmodified
 * `websocket.js`'s default behaviour) alongside the server's own pipeline
 * connection (the real store graph running in Node) for the same account —
 * each mints its own `/auth` token, and one rotating the token out from
 * under the other produced a real, intermittent "authToken doesn't
 * correspond with an active session" pipeline error frame. Routing through
 * the server's single connection (the same fix already proven for the web
 * client) removes the second, competing connection entirely.
 *
 * Also ports `client-web/bootstrap.js`'s `installGroupInstanceRelayTap()` —
 * found live the same day: without it, the Groups sidebar stayed empty on
 * desktop even though `server/src/group-instance-relay.js`'s synthetic
 * `vrcx-headless-group-instances` frame was arriving fine (visible as an
 * expected, harmless "Unknown pipeline type" log from `handlePipeline`,
 * which has no case for it by design — see that file's own doc comment).
 * The web client catches that specific frame with a second, independent tap
 * and calls `handleGroupUserInstances` directly; this relay forwarded every
 * frame to `.onmessage` but never did that second tap.
 */
import { AppDebug } from '../../src/services/appConfig.js';
import { handleGroupUserInstances } from '../../src/coordinators/groupCoordinator.js';

const RELAY_DOMAIN = 'vrcx-desktop-stream:';

/**
 * @param {string} data
 */
function tapGroupInstanceFrame(data) {
    let frame;
    try {
        frame = JSON.parse(data);
    } catch {
        return;
    }
    if (frame?.type !== 'vrcx-headless-group-instances') {
        return;
    }
    let payload;
    try {
        payload = JSON.parse(frame.content);
    } catch {
        return;
    }
    handleGroupUserInstances({ json: payload });
}

export function installPipelineRelay() {
    AppDebug.websocketDomain = RELAY_DOMAIN;

    const NativeWebSocket = window.WebSocket;
    let activeSocket = null;

    class DesktopRelayWebSocket {
        constructor(url, protocols) {
            if (typeof url !== 'string' || !url.startsWith(RELAY_DOMAIN)) {
                return new NativeWebSocket(url, protocols);
            }
            this.onopen = null;
            this.onclose = null;
            this.onerror = null;
            this.onmessage = null;
            this.readyState = 0; // CONNECTING
            activeSocket = this;
            window.vrcxDesktopAgent.streamConnect();
        }

        close() {
            if (activeSocket === this) {
                activeSocket = null;
                window.vrcxDesktopAgent.streamClose();
            }
            this.readyState = 3; // CLOSED
        }
    }

    window.vrcxDesktopAgent.onStreamEvent((evt) => {
        const socket = activeSocket;
        if (!socket) {
            return;
        }
        switch (evt.type) {
            case 'open':
                socket.readyState = 1; // OPEN
                socket.onopen?.();
                break;
            case 'message':
                tapGroupInstanceFrame(evt.data);
                socket.onmessage?.({ data: evt.data });
                break;
            case 'close':
                socket.readyState = 3; // CLOSED
                activeSocket = null;
                socket.onclose?.(
                    new CloseEvent('close', {
                        code: evt.code ?? 1006,
                        reason: evt.reason ?? ''
                    })
                );
                break;
            case 'error':
                socket.onerror?.();
                break;
        }
    });

    window.WebSocket = DesktopRelayWebSocket;
}
