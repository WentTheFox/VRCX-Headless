/**
 * Headless stand-in for `src/shared/utils/index.js`.
 *
 * Aliased in for one symbol: `src/services/sqlite.js` calls `openExternalLink`
 * to send the user to the database-repair wiki page. The real barrel re-exports
 * a large tree of browser utilities (DOM, canvas, AppApi).
 *
 * If a future upstream merge makes the data layer depend on a *real* utility
 * from this barrel, do not grow this stub: drop the alias and fix the specific
 * browser-only module instead. See CLAUDE.md -> "Seam table".
 */
import { log } from '../log.js';

/**
 * @param {string} url
 */
export function openExternalLink(url) {
    log.info('openExternalLink suppressed (headless)', { url });
}
