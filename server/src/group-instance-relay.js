/**
 * Relays the raw VRChat "user's group instances" REST response to
 * connected `/api/stream` clients, so their own `groupStore.groupInstances`
 * (the Groups sidebar — friends currently in a joinable group instance) gets
 * populated too. Today it never does: `src/stores/updateLoop.js` is the
 * *only* code path that calls `groupRequest.getUsersGroupInstances()` +
 * `handleGroupUserInstances()` (both real, unmodified upstream — the
 * coordinator, `src/coordinators/groupCoordinator.js`, and the loop itself),
 * and that loop is a deliberate permanent no-op on every client
 * (`client-web/shims/update-loop.js`, `client-desktop/shims/update-loop.js`)
 * by the seam table's own design — "server owns the one real loop, not one
 * per client". So this one piece of server-computed, in-memory-only Pinia
 * state never reaches any client, unlike everything else `database.*`
 * persists.
 *
 * ## Why tap `WebApiShim.Execute`, not `updateLoop.js`/`groupCoordinator.js`
 *
 * Both of those are real, unmodified upstream files — editing either to add
 * a broadcast call would be an avoidable `src/` edit invariants 2/3
 * disfavor when an alias/tap is available. `WebApiShim`
 * (`server/src/shims/webapi.js`) is entirely ours — the seam table's own
 * designated VRChat-HTTP boundary — so wrapping its `Execute` method here,
 * matched by URL to exactly one REST endpoint
 * (`users/{id}/instances/groups`), is the smallest hook with zero risk to
 * any other call. Same spirit as `pipeline-relay.js`'s `WebSocket`-
 * constructor tap: intercept at *our* seam, not upstream's call site.
 *
 * ## Wire format
 *
 * The relayed payload is sent over the *same* `/api/stream` connection as
 * real VRChat pipeline frames (`server/src/http-server.js`), shaped to look
 * like one (`{type, content}`, `content` JSON-*string*-encoded — matching
 * the real wire format's double-encoding, not just its top-level shape) so
 * `src/services/websocket.js`'s own unmodified `handlePipeline` sees a
 * well-formed frame with an unrecognized `type` and just
 * `console.log`s "Unknown pipeline type" — harmless, not a special-cased
 * bypass of the real client's own message handling. The actual work happens
 * in a *second*, independent listener the client installs the same way this
 * file does: tapping the `WebSocket` constructor to add an extra
 * `addEventListener('message', …)`, proven side-effect-free alongside
 * `websocket.js`'s own `.onmessage` by `pipeline-relay.js`'s own doc
 * comment.
 */
import { EventEmitter } from 'node:events';

export const groupInstanceRelay = new EventEmitter();

const GROUP_INSTANCES_URL_MARKER = '/instances/groups';

/**
 * @param {import('./shims/webapi.js').WebApiShim} webApiInstance
 */
export function installGroupInstanceRelay(webApiInstance) {
    if (webApiInstance.__vrcxGroupInstanceRelayPatched) {
        return;
    }
    webApiInstance.__vrcxGroupInstanceRelayPatched = true;
    const originalExecute = webApiInstance.Execute.bind(webApiInstance);
    webApiInstance.Execute = async (options) => {
        const result = await originalExecute(options);
        if (
            result.Item1 !== -1 &&
            typeof options?.url === 'string' &&
            options.url.includes(GROUP_INSTANCES_URL_MARKER)
        ) {
            try {
                groupInstanceRelay.emit('update', JSON.parse(result.Item2));
            } catch {
                // Malformed body — best-effort relay; the real caller
                // (handleGroupUserInstances, via the normal in-process flow)
                // still gets this response and handles it the usual way.
            }
        }
        return result;
    };
}
