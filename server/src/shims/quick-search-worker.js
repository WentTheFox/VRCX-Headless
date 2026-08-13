/**
 * Headless stand-in for `src/stores/quickSearchWorker.js`, imported by
 * `src/stores/quickSearch.js` via Vite-only `?worker&inline` syntax.
 *
 * Unlike `activityWorkerRunner.js` (`server/src/shims/activity-worker-runner.js`),
 * this worker's confusable-character/search logic is deliberately inlined
 * with zero imports (its own header comment: "to avoid Worker-scope import
 * issues") and keeps live index state (`updateIndex`) in worker-scope
 * closures the outside world has no access to. That logic can't be
 * duplicated here without silently diverging from upstream on every edit,
 * so this loads the **real, unmodified file's source** instead, through a
 * `data:` URL rather than a normal relative import — `server/aliases.js`
 * maps this exact file's own repo-relative path to this shim, so a plain
 * `import('.../quickSearchWorker.js')` from in here would just resolve back
 * to itself and deadlock. `self` is polyfilled with just enough surface to
 * satisfy the real file's module-scope `self.addEventListener('message', …)`
 * call, and the default export wraps that same polyfill in the
 * `postMessage`/`onmessage` shape `quickSearch.js` expects from
 * `new QuickSearchWorker()`.
 *
 * Inbound (main → worker) and outbound (worker → main) are kept as two
 * separate one-way callback slots, not a shared pub/sub bus — routing both
 * directions through one `EventTarget` would echo the worker's own replies
 * back into its inbound handler as unrecognised message types.
 *
 * `self` is process-global, and the inbound handler is captured once, the
 * first time this module loads (the `data:` import happens once — this
 * module is itself an ES module singleton). That is fine for direct
 * request/reply pairs (`updateIndex` / `search`), because `quickSearch.js`
 * only ever holds one worker instance at a time. It is a real behavioural
 * difference from a browser `Worker`, though: `.terminate()` there discards
 * the worker's state entirely, while here the search index survives past
 * `terminate()` since it lives in the one real module instance loaded here.
 * Harmless in practice — `quickSearch.js` re-sends `updateIndex` after
 * recreating the worker — but worth knowing if that assumption ever changes
 * upstream.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let inboundHandler = null;
let activeInstance = null;

globalThis.self ??= {
    addEventListener(type, handler) {
        if (type === 'message') inboundHandler = handler;
    },
    postMessage(data) {
        activeInstance?.onmessage?.({ data });
    }
};

const realFilePath = fileURLToPath(
    new URL('../../../src/stores/quickSearchWorker.js', import.meta.url)
);
const realFileSource = readFileSync(realFilePath, 'utf8');
await import(
    `data:text/javascript;base64,${Buffer.from(realFileSource).toString('base64')}`
);

export default class QuickSearchWorker {
    constructor() {
        this.onmessage = null;
        activeInstance = this;
    }

    /** @param {any} data */
    postMessage(data) {
        inboundHandler?.({ data });
    }

    terminate() {
        if (activeInstance === this) activeInstance = null;
    }
}
