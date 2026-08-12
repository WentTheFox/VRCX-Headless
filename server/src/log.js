/**
 * Minimal structured logger.
 *
 * Deliberately dependency-free and boring. Phase 3 turns these into events on
 * the client stream (so a browser can surface what a `toast()` would have said
 * in the desktop app); until then they just go to stderr/stdout.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = LEVELS[process.env.VRCX_LOG_LEVEL] ?? LEVELS.info;

/**
 * @param {keyof typeof LEVELS} level
 * @param {string} message
 * @param {unknown} [detail]
 */
function emit(level, message, detail) {
    if (LEVELS[level] < threshold) {
        return;
    }
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
    const stream =
        level === 'error' || level === 'warn' ? console.error : console.log;
    if (detail === undefined) {
        stream(line);
    } else {
        stream(line, detail);
    }
}

export const log = {
    debug: (message, detail) => emit('debug', message, detail),
    info: (message, detail) => emit('info', message, detail),
    warn: (message, detail) => emit('warn', message, detail),
    error: (message, detail) => emit('error', message, detail)
};
