import { describe, expect, test } from 'vitest';

import { useGroupModerationSelection } from '../useGroupModerationSelection';

// useGroupModerationSelection() now takes the whole groupMemberModeration
// state object (tables + selectedUsers/selectedUsersArray) and mutates it
// in place, rather than taking just `tables` and returning its own
// selectedUsers/selectedUsersArray refs.
function createModeration() {
    return {
        tables: {
            members: { data: [] },
            bans: { data: [] },
            invites: { data: [] },
            joinRequests: { data: [] },
            blocked: { data: [] }
        },
        selectedUsers: {},
        selectedUsersArray: []
    };
}

describe('useGroupModerationSelection', () => {
    describe('setSelectedUsers', () => {
        test('adds a user to selection', () => {
            const moderation = createModeration();
            const { setSelectedUsers } = useGroupModerationSelection(moderation);

            setSelectedUsers('usr_1', { userId: 'usr_1', name: 'Alice' });

            expect(moderation.selectedUsers['usr_1']).toEqual({
                userId: 'usr_1',
                name: 'Alice'
            });
            expect(moderation.selectedUsersArray).toHaveLength(1);
        });

        test('ignores null user', () => {
            const moderation = createModeration();
            const { setSelectedUsers } = useGroupModerationSelection(moderation);

            setSelectedUsers('usr_1', null);

            expect(moderation.selectedUsersArray).toHaveLength(0);
        });

        test('adds multiple users', () => {
            const moderation = createModeration();
            const { setSelectedUsers } = useGroupModerationSelection(moderation);

            setSelectedUsers('usr_1', { userId: 'usr_1', name: 'Alice' });
            setSelectedUsers('usr_2', { userId: 'usr_2', name: 'Bob' });

            expect(moderation.selectedUsersArray).toHaveLength(2);
        });
    });

    describe('deselectedUsers', () => {
        test('removes a specific user', () => {
            const moderation = createModeration();
            const { setSelectedUsers, deselectedUsers } = useGroupModerationSelection(moderation);

            setSelectedUsers('usr_1', { userId: 'usr_1', name: 'Alice' });
            setSelectedUsers('usr_2', { userId: 'usr_2', name: 'Bob' });
            deselectedUsers('usr_1');

            expect(moderation.selectedUsers['usr_1']).toBeUndefined();
            expect(moderation.selectedUsersArray).toHaveLength(1);
            expect(moderation.selectedUsersArray[0].name).toBe('Bob');
        });

        test('removes all users when isAll=true', () => {
            const moderation = createModeration();
            const { setSelectedUsers, deselectedUsers } = useGroupModerationSelection(moderation);

            setSelectedUsers('usr_1', { userId: 'usr_1', name: 'Alice' });
            setSelectedUsers('usr_2', { userId: 'usr_2', name: 'Bob' });
            deselectedUsers(null, true);

            expect(moderation.selectedUsersArray).toHaveLength(0);
        });
    });

    describe('onSelectionChange', () => {
        test('selects user when row.$selected is true', () => {
            const moderation = createModeration();
            const { onSelectionChange } = useGroupModerationSelection(moderation);

            onSelectionChange({
                userId: 'usr_1',
                name: 'Alice',
                $selected: true
            });

            expect(moderation.selectedUsersArray).toHaveLength(1);
        });

        test('deselects user when row.$selected is false', () => {
            const moderation = createModeration();
            const { setSelectedUsers, onSelectionChange } = useGroupModerationSelection(moderation);

            setSelectedUsers('usr_1', { userId: 'usr_1', name: 'Alice' });
            onSelectionChange({ userId: 'usr_1', $selected: false });

            expect(moderation.selectedUsersArray).toHaveLength(0);
        });
    });

    describe('deselectInTables', () => {
        test('deselects specific user in table data', () => {
            const moderation = createModeration();
            moderation.tables.members.data = [
                { userId: 'usr_1', $selected: true },
                { userId: 'usr_2', $selected: true }
            ];
            const { deselectInTables } = useGroupModerationSelection(moderation);

            deselectInTables('usr_1');

            expect(moderation.tables.members.data[0].$selected).toBe(false);
            expect(moderation.tables.members.data[1].$selected).toBe(true);
        });

        test('deselects all users when no userId', () => {
            const moderation = createModeration();
            moderation.tables.members.data = [
                { userId: 'usr_1', $selected: true },
                { userId: 'usr_2', $selected: true }
            ];
            moderation.tables.bans.data = [{ userId: 'usr_3', $selected: true }];
            const { deselectInTables } = useGroupModerationSelection(moderation);

            deselectInTables();

            expect(moderation.tables.members.data[0].$selected).toBe(false);
            expect(moderation.tables.members.data[1].$selected).toBe(false);
            expect(moderation.tables.bans.data[0].$selected).toBe(false);
        });

        test('handles null table gracefully', () => {
            const moderation = createModeration();
            moderation.tables.members = null;
            const { deselectInTables } = useGroupModerationSelection(moderation);

            expect(() => deselectInTables('usr_1')).not.toThrow();
        });
    });

    describe('deleteSelectedUser', () => {
        test('removes user from selection and tables', () => {
            const moderation = createModeration();
            moderation.tables.members.data = [{ userId: 'usr_1', $selected: true }];
            const { setSelectedUsers, deleteSelectedUser } = useGroupModerationSelection(moderation);

            setSelectedUsers('usr_1', { userId: 'usr_1', name: 'Alice' });
            deleteSelectedUser({ userId: 'usr_1' });

            expect(moderation.selectedUsersArray).toHaveLength(0);
            expect(moderation.tables.members.data[0].$selected).toBe(false);
        });
    });

    describe('clearAllSelected', () => {
        test('clears all selections and table states', () => {
            const moderation = createModeration();
            moderation.tables.members.data = [
                { userId: 'usr_1', $selected: true },
                { userId: 'usr_2', $selected: true }
            ];
            moderation.tables.bans.data = [{ userId: 'usr_3', $selected: true }];
            const { setSelectedUsers, clearAllSelected } = useGroupModerationSelection(moderation);

            setSelectedUsers('usr_1', { userId: 'usr_1' });
            setSelectedUsers('usr_2', { userId: 'usr_2' });
            setSelectedUsers('usr_3', { userId: 'usr_3' });

            clearAllSelected();

            expect(moderation.selectedUsersArray).toHaveLength(0);
            expect(moderation.tables.members.data.every((r) => !r.$selected)).toBe(true);
            expect(moderation.tables.bans.data.every((r) => !r.$selected)).toBe(true);
        });
    });

    describe('selectAll', () => {
        test('selects all rows in a table', () => {
            const moderation = createModeration();
            const tableData = [
                { userId: 'usr_1', $selected: false },
                { userId: 'usr_2', $selected: false }
            ];
            const { selectAll } = useGroupModerationSelection(moderation);

            selectAll(tableData);

            expect(tableData.every((r) => r.$selected)).toBe(true);
            expect(moderation.selectedUsersArray).toHaveLength(2);
        });
    });
});
