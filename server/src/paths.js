/**
 * Locates VRCX's data directory and database file.
 *
 * Ports the resolution order used by the desktop app so that the server points
 * at the *same* file an existing install already uses:
 *
 *   1. `VRCX_DATABASE` env var (server-only escape hatch)
 *   2. `VRCX_DatabaseLocation` in VRCX.json  (Dotnet/SQLite.cs:33)
 *   3. <appdata>/VRCX/VRCX.sqlite3           (Dotnet/Program.cs:33)
 *
 * The app data directory itself follows Program.cs:28, which uses .NET's
 * `SpecialFolder.ApplicationData` — %APPDATA% on Windows, and
 * $XDG_CONFIG_HOME (default ~/.config) elsewhere.
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @returns {string} absolute path to the VRCX app data directory
 */
export function resolveAppDataDirectory() {
    if (process.env.VRCX_DATA_DIR) {
        return path.resolve(process.env.VRCX_DATA_DIR);
    }
    if (process.platform === 'win32') {
        const appData =
            process.env.APPDATA ??
            path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, 'VRCX');
    }
    const configHome =
        process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
    return path.join(configHome, 'VRCX');
}

/**
 * Reads the `VRCX_DatabaseLocation` override out of VRCX.json, the JSON
 * key/value store owned by Dotnet/VRCXStorage.cs.
 *
 * @param {string} appDataDirectory
 * @returns {string | null}
 */
export function readDatabaseLocationOverride(appDataDirectory) {
    const storagePath = path.join(appDataDirectory, 'VRCX.json');
    if (!existsSync(storagePath)) {
        return null;
    }
    try {
        const parsed = JSON.parse(readFileSync(storagePath, 'utf8'));
        const override = parsed?.VRCX_DatabaseLocation;
        return typeof override === 'string' && override.length > 0
            ? override
            : null;
    } catch {
        // A malformed VRCX.json must not stop the server from booting; the
        // desktop app treats a missing key the same way.
        return null;
    }
}

/**
 * @returns {{ appDataDirectory: string, databasePath: string, source: string }}
 */
export function resolveDatabasePath() {
    const appDataDirectory = resolveAppDataDirectory();

    if (process.env.VRCX_DATABASE) {
        return {
            appDataDirectory,
            databasePath: path.resolve(process.env.VRCX_DATABASE),
            source: 'VRCX_DATABASE env var'
        };
    }

    const override = readDatabaseLocationOverride(appDataDirectory);
    if (override) {
        return {
            appDataDirectory,
            databasePath: path.resolve(override),
            source: 'VRCX_DatabaseLocation in VRCX.json'
        };
    }

    return {
        appDataDirectory,
        databasePath: path.join(appDataDirectory, 'VRCX.sqlite3'),
        source: 'default app data location'
    };
}
