/**
 * Pure helpers behind the VRChat settings backup (registry + config.json),
 * kept out of `src/stores/vrcx.js` so the limits and the integrity check can
 * be tested without building the store graph. Fork-owned file.
 */

// config.json is a few hundred bytes. Only that one file is ever backed up,
// never the cache folder beside it (several GB), so this is a sanity cap.
export const MAX_VRC_CONFIG_BACKUP_CHARS = 256 * 1024;
// The whole list is one config value sent through /api/rpc, whose body limit
// is 1 MiB (server/src/http-server.js MAX_BODY_BYTES). A registry backup is
// ~44K chars (measured: ~580 keys), ~50K once JSON-escaped on the wire, so the
// counts below fit comfortably (13 x 44K) and the budget is the hard stop,
// staying well under the limit even if backups grow.
export const MAX_AUTO_VRC_BACKUPS = 7;
export const MAX_MANUAL_VRC_BACKUPS = 6;
export const MAX_VRC_BACKUPS_TOTAL_CHARS = 650_000;
export const AUTO_VRC_BACKUP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const AUTO_VRC_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Entries made before the `auto` flag existed were all named exactly this.
 *
 * @param {{ auto?: boolean; name?: string }} backup
 */
export function isAutoVrcBackup(backup) {
    return backup.auto === true || backup.name === 'Auto Backup';
}

/**
 * SHA-256 over exactly the content a restore would write, so a backup that
 * was edited or corrupted in storage is refused instead of applied.
 *
 * @param {any} data Registry JSON
 * @param {string | undefined} configJson
 * @returns {Promise<string>} Lowercase hex
 */
export async function hashVrcBackup(data, configJson) {
    const bytes = new TextEncoder().encode(JSON.stringify({ data, configJson: configJson ?? null }));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {string | null | undefined} configJson
 * @returns {string | undefined} The text if it's worth embedding, else undefined
 */
export function embeddableConfigJson(configJson) {
    return configJson && configJson.length <= MAX_VRC_CONFIG_BACKUP_CHARS ? configJson : undefined;
}

/**
 * Throws unless the entry is safe to restore. Entries from before hashing
 * existed have no hash: a manual restore may still apply them, an automatic
 * one (`requireHash`) never does.
 *
 * @param {{ data: any; configJson?: string; hash?: string }} entry
 * @param {boolean} requireHash
 */
export async function verifyVrcBackup(entry, requireHash) {
    if (entry.hash) {
        if (entry.hash !== (await hashVrcBackup(entry.data, entry.configJson))) {
            throw new Error('Backup failed its integrity check (hash mismatch), not restoring');
        }
    } else if (requireHash) {
        throw new Error('Backup has no integrity hash, not restoring automatically');
    }
}

/**
 * @param {{ auto?: boolean; name?: string }[]} backups
 * @param {boolean} auto Whether the backup about to be added is automatic
 */
export function canAddVrcBackup(backups, auto) {
    return auto || backups.filter((b) => !isAutoVrcBackup(b)).length < MAX_MANUAL_VRC_BACKUPS;
}

/**
 * Makes room for one more automatic backup: drops automatic ones past the
 * max age, then the oldest until at most MAX - 1 remain. Manual backups are
 * never touched. Returns a new array.
 *
 * @param {{ auto?: boolean; name?: string; date: string }[]} backups
 * @param {number} nowMs
 */
export function pruneAutoVrcBackups(backups, nowMs) {
    const kept = backups.filter(
        (b) => !isAutoVrcBackup(b) || new Date(b.date).getTime() >= nowMs - AUTO_VRC_BACKUP_MAX_AGE_MS
    );
    const autos = kept.filter(isAutoVrcBackup).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const drop = new Set(autos.slice(0, Math.max(0, autos.length - (MAX_AUTO_VRC_BACKUPS - 1))));
    return kept.filter((b) => !drop.has(b));
}

/**
 * @param {{ date: string }[]} backups
 * @returns {{ date: string } | null} The most recent entry, any kind
 */
export function latestVrcBackup(backups) {
    return backups.reduce((a, b) => (!a || new Date(b.date) > new Date(a.date) ? b : a), null);
}

/**
 * @param {string | null | undefined} lastBackupDate
 * @param {number} nowMs
 */
export function isAutoVrcBackupDue(lastBackupDate, nowMs) {
    return !lastBackupDate || nowMs - new Date(lastBackupDate).getTime() >= AUTO_VRC_BACKUP_INTERVAL_MS;
}

/**
 * Makes the list fit MAX_VRC_BACKUPS_TOTAL_CHARS (as serialized), dropping
 * the oldest automatic backups first. The just-added entry is never dropped
 * and manual backups never are.
 *
 * @param {{ auto?: boolean; name?: string; date: string }[]} backups Includes `newest`
 * @param {object} newest
 * @returns {any[] | null} The list to store, or null if it can't fit
 */
export function fitVrcBackupsToBudget(backups, newest) {
    const result = [...backups];
    while (JSON.stringify(result).length > MAX_VRC_BACKUPS_TOTAL_CHARS) {
        const oldestAuto = result
            .filter((b) => b !== newest && isAutoVrcBackup(b))
            .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())[0];
        if (!oldestAuto) {
            return null;
        }
        result.splice(result.indexOf(oldestAuto), 1);
    }
    return result;
}
