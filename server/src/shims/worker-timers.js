/**
 * Headless stand-in for the `worker-timers` npm package.
 *
 * Upstream uses it everywhere (updateLoop, websocket reconnect, ~14 modules)
 * to dodge browser background-tab timer throttling. It schedules through a Web
 * Worker created from a blob URL, and `Worker` does not exist in Node — the
 * failure surfaces on the first `setTimeout` call, not at import, so it looks
 * like a mystery crash mid-run rather than a missing dependency.
 *
 * Node has no throttling to dodge, so plain timers are the correct behaviour.
 * Upstream's own vitest.setup.js mocks the package exactly this way.
 */

/**
 * @param {Function} handler
 * @param {number} [timeout]
 * @returns {number}
 */
export function setTimeout(handler, timeout) {
    // Node returns a Timeout object; upstream only ever passes the value back
    // to clearTimeout, so the object is fine, but `Symbol.toPrimitive` keeps it
    // usable if anything compares or logs it as a number.
    return globalThis.setTimeout(handler, timeout);
}

/**
 * @param {number} timerId
 */
export function clearTimeout(timerId) {
    return globalThis.clearTimeout(timerId);
}

/**
 * @param {Function} handler
 * @param {number} [timeout]
 * @returns {number}
 */
export function setInterval(handler, timeout) {
    return globalThis.setInterval(handler, timeout);
}

/**
 * @param {number} timerId
 */
export function clearInterval(timerId) {
    return globalThis.clearInterval(timerId);
}
