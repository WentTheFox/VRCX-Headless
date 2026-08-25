import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

const mocks = vi.hoisted(() => ({
    setString: vi.fn(() => Promise.resolve()),
    getString: vi.fn(() => Promise.resolve(null))
}));

vi.mock('../../../../services/config', () => ({
    default: {
        setString: mocks.setString,
        getString: mocks.getString
    }
}));

vi.mock('../../navMenuUtils', () => ({
    normalizeHiddenKeys: (keys) => keys || [],
    sanitizeLayout: (layout) => layout
}));

// useNavLayout() reads only `notificationLayout` off this store -- mocked
// directly rather than pulling in the real store's own dependency chain
// (game/photon/user/... stores), which this composable-level test was never
// set up to exercise.
vi.mock('../../../../stores/settings/notifications', () => ({
    useNotificationsSettingsStore: () => ({ notificationLayout: 'toast' })
}));

import { useNavLayout } from '../useNavLayout';

describe('useNavLayout', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
    });

    const createDeps = () => {
        const push = vi.fn();
        const router = {
            push,
            currentRoute: ref({ name: 'unknown', meta: {} })
        };
        const dashboardStore = {
            getDashboardNavDefinitions: () => [],
            dashboardNavKeys: new Set()
        };

        return {
            router,
            push,
            dashboardStore,
            dashboards: ref([]),
            locale: ref('en'),
            directAccessPaste: vi.fn()
        };
    };

    it('triggers direct access action', () => {
        const deps = createDeps();
        const { triggerNavAction } = useNavLayout({
            t: (key) => key,
            locale: deps.locale,
            router: deps.router,
            dashboardStore: deps.dashboardStore,
            dashboards: deps.dashboards,
            directAccessPaste: deps.directAccessPaste
        });

        triggerNavAction({ action: 'direct-access' });

        expect(deps.directAccessPaste).toHaveBeenCalledTimes(1);
    });

    it('navigates with route name and params', () => {
        const deps = createDeps();
        const { triggerNavAction } = useNavLayout({
            t: (key) => key,
            locale: deps.locale,
            router: deps.router,
            dashboardStore: deps.dashboardStore,
            dashboards: deps.dashboards,
            directAccessPaste: deps.directAccessPaste
        });

        triggerNavAction({ routeName: 'dashboard', routeParams: { id: '1' } });

        expect(deps.push).toHaveBeenCalledWith({
            name: 'dashboard',
            params: { id: '1' }
        });
    });

    it('applies custom layout and persists', async () => {
        const deps = createDeps();
        const { applyCustomNavLayout, navLayout } = useNavLayout({
            t: (key) => key,
            locale: deps.locale,
            router: deps.router,
            dashboardStore: deps.dashboardStore,
            dashboards: deps.dashboards,
            directAccessPaste: deps.directAccessPaste
        });

        const layout = [{ type: 'item', key: 'feed' }];
        await applyCustomNavLayout(layout, []);
        await nextTick();

        expect(navLayout.value).toEqual(expect.arrayContaining(layout));
        expect(mocks.setString).toHaveBeenCalled();
    });
});
