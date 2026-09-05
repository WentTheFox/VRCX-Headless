/**
 * Wraps the 5 feed-writing methods on the real, unmodified `database`
 * facade (`src/services/database/feed.js`), plus `addFriendLogHistory`
 * (`src/services/database/friendLogHistory.js`), with a near-duplicate
 * check.
 *
 * Both the server's own pipeline processing and every client's RPC-relayed
 * "write" call the exact same method on this shared object (Node's module
 * cache guarantees one instance) -- the client still runs the real,
 * unmodified `handlePipeline` against relayed pipeline frames, same
 * reasoning as `client-web/shims/database.js`'s pre-existing
 * `pipelineOnlyWrites` allowlist. That allowlist only covers
 * `addOnlineOfflineToDatabase`, whose only 2 call sites are both
 * exclusively inside a pipeline-only flow -- but GPS/status/avatar/bio all
 * funnel through `runHandleUserUpdateFlow`, reached via `applyUser` from
 * many places (`src/api/user.js`, `src/api/friend.js`, `src/stores/
 * search.js`, `src/stores/photon.js`, not just `websocket.js`'s pipeline
 * handler), so a client-side "always no-op" allowlist isn't safe for
 * those -- it would silently drop legitimate feed writes triggered by
 * direct actions. `addFriendship`/`updateFriendship`/
 * `runDeleteFriendshipFlow` (`src/coordinators/friendRelationshipCoordinator.js`)
 * have the exact same shape: every connected client (and the server
 * itself) runs the real, unmodified `handlePipeline` -> `handleFriendAdd`
 * -> `addFriendship` against the same relayed `friend-add`/`friend-delete`
 * frame, and each independently decides "not yet in my local `friendLog`
 * map" and calls `database.addFriendLogHistory` -- one row per connected
 * client, found live (2026-09-06: a new friend showed up duplicated once
 * per connected client in Friend Log).
 *
 * Deduping here instead, by content rather than by caller, sidesteps that
 * entirely: a genuinely new event's content won't match a recent row and
 * still inserts normally, from any source. The existing `INSERT OR IGNORE`
 * in feed.js/friendLogHistory.js only catches byte-identical rows, but the
 * server-side and client-relayed writes for the *same* real event each
 * compute their own `created_at` independently (found live, 2026-08-18:
 * real duplicate rows in `feed_gps`/`feed_avatar` a few hundred ms to ~1s
 * apart), so that never fires for this case.
 */
import sqliteService from '../../src/services/sqlite.js';

// Comfortably covers the sub-second gap observed between the two redundant
// writes for the same event, without being wide enough to ever merge two
// genuinely different real-world events for the same user.
const DEDUP_WINDOW_SECONDS = 10;

/** @type {Record<string, { table: string, fields: (entry: object) => Record<string, unknown> }>} */
const DEDUP_CONFIGS = {
    addGPSToDatabase: {
        table: 'feed_gps',
        fields: (entry) => ({
            location: entry.location,
            previous_location: entry.previousLocation
        })
    },
    addStatusToDatabase: {
        table: 'feed_status',
        fields: (entry) => ({
            status: entry.status,
            previous_status: entry.previousStatus
        })
    },
    addBioToDatabase: {
        table: 'feed_bio',
        fields: (entry) => ({
            bio: entry.bio,
            previous_bio: entry.previousBio
        })
    },
    addAvatarToDatabase: {
        table: 'feed_avatar',
        fields: (entry) => ({
            owner_id: entry.ownerId,
            current_avatar_image_url: entry.currentAvatarImageUrl
        })
    },
    addOnlineOfflineToDatabase: {
        table: 'feed_online_offline',
        fields: (entry) => ({
            type: entry.type,
            location: entry.location
        })
    },
    addFriendLogHistory: {
        table: 'friend_log_history',
        fields: (entry) => ({
            type: entry.type,
            display_name: entry.displayName,
            previous_display_name: entry.previousDisplayName,
            trust_level: entry.trustLevel,
            previous_trust_level: entry.previousTrustLevel,
            friend_number: entry.friendNumber
        })
    }
};

async function hasRecentDuplicate(table, userPrefix, fields, entry) {
    const params = {
        '@created_at': entry.created_at,
        '@user_id': entry.userId
    };
    // `column IS @param` (not `=`) so a NULL field value still matches a
    // NULL column -- several of these fields (e.g. previous_location on a
    // user's first-ever GPS entry) are legitimately NULL.
    const clauses = ['user_id = @user_id', "ABS(strftime('%s', @created_at) - strftime('%s', created_at)) <= " + DEDUP_WINDOW_SECONDS];
    for (const [column, value] of Object.entries(fields)) {
        const param = `@${column}`;
        clauses.push(`${column} IS ${param}`);
        params[param] = value;
    }

    let count = 0;
    await sqliteService.execute(
        (row) => {
            count = row[0];
        },
        `SELECT COUNT(*) FROM ${userPrefix}_${table} WHERE ${clauses.join(' AND ')}`,
        params
    );
    return count > 0;
}

/**
 * @param {Record<string, Function>} database the real `database` facade
 * @param {{ userPrefix: string }} dbVars
 */
export function installFeedDedup(database, dbVars) {
    for (const [method, config] of Object.entries(DEDUP_CONFIGS)) {
        const original = database[method].bind(database);
        database[method] = async function feedDedupWrapper(entry) {
            const duplicate = await hasRecentDuplicate(
                config.table,
                dbVars.userPrefix,
                config.fields(entry),
                entry
            );
            if (duplicate) {
                return;
            }
            return original(entry);
        };
    }
}
