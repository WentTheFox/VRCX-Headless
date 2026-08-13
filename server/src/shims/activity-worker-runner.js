/**
 * Headless stand-in for `src/workers/activityWorkerRunner.js`.
 *
 * The real module's only content is `import ActivityWorker from
 * './activityWorker.js?worker&inline'` — Vite-only syntax that fails to
 * resolve under Node, and unlike the other missing-global cases (§3.7) this
 * one can't be deferred to call time: it fails at import/link time.
 *
 * The worker exists purely to keep VRChat's activity-heatmap computation off
 * the browser's main thread; every case in its `onmessage` switch
 * (`src/workers/activityWorker.js`) is a pure, synchronous function from
 * `src/shared/utils/activityEngine.js`. Node has no main thread to protect,
 * so this runs the same dispatch in-process instead of aliasing the whole
 * `src/stores/activity.js` store (invariant 3: alias the smallest module).
 *
 * Keep this switch in sync with `src/workers/activityWorker.js`'s — it is a
 * deliberate duplication (editing that file would violate invariant 1) and
 * is called out in CLAUDE.md §6.2 as an upstream-merge watch item.
 */
import {
    buildDailySummary,
    buildHeatmapBuckets,
    buildOverlapBuckets,
    buildSessionsFromEvents,
    buildSessionsFromGamelog,
    computeActivityView,
    computeOverlapView,
    normalizeBuckets
} from '../../../src/shared/utils/activityEngine.js';

function computeSessionsSnapshot(payload) {
    const sourceRevision = payload.sourceRevision || '';
    if (payload.sourceType === 'self_gamelog') {
        const sessions = buildSessionsFromGamelog(
            payload.rows,
            payload.mergeGapMs,
            payload.nowMs
        ).map((session, index, list) => ({
            ...session,
            isOpenTail:
                index === list.length - 1 && payload.mayHaveOpenTail === true,
            sourceRevision
        }));
        return { sessions, pendingSessionStartAt: null };
    }

    const result = buildSessionsFromEvents(payload.events, payload.initialStart);
    return {
        pendingSessionStartAt: result.pendingSessionStartAt,
        sessions: result.sessions.map((session) => ({
            ...session,
            isOpenTail: false,
            sourceRevision
        }))
    };
}

/**
 * @param {string} type
 * @param {any} payload
 * @returns {Promise<any>}
 */
export async function runActivityWorkerTask(type, payload) {
    switch (type) {
        case 'computeSessionsSnapshot':
            return computeSessionsSnapshot(payload);
        case 'computeActivityView':
            return computeActivityView(payload);
        case 'computeOverlapView':
            return computeOverlapView(payload);
        case 'buildSessionsFromGamelog':
            return {
                sessions: buildSessionsFromGamelog(
                    payload.rows || [],
                    payload.mergeGapMs,
                    payload.nowMs
                )
            };
        case 'buildSessionsFromEvents':
            return buildSessionsFromEvents(
                payload.events || [],
                payload.initialStart ?? null
            );
        case 'buildHeatmapBuckets':
            return {
                buckets: buildHeatmapBuckets(
                    payload.sessions || [],
                    payload.windowStartMs,
                    payload.nowMs,
                    payload.maxSessionMs
                )
            };
        case 'buildOverlapBuckets':
            return {
                buckets: buildOverlapBuckets(
                    payload.selfSessions || [],
                    payload.friendSessions || [],
                    payload.windowStartMs,
                    payload.nowMs,
                    payload.maxSessionMs
                )
            };
        case 'normalizeHeatmapBuckets':
            return {
                normalized: normalizeBuckets(payload.buckets || [], payload.config || {})
            };
        case 'computeDailySummary':
            return {
                dailySummary: buildDailySummary(
                    payload.sessions || [],
                    payload.rangeStartMs,
                    payload.rangeEndMs
                )
            };
        default:
            throw new Error(`Unknown activity worker task: ${type}`);
    }
}
