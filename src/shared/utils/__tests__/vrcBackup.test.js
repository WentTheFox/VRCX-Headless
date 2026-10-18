import { describe, expect, test } from 'vitest';

import {
    AUTO_VRC_BACKUP_MAX_AGE_MS,
    MAX_AUTO_VRC_BACKUPS,
    MAX_MANUAL_VRC_BACKUPS,
    MAX_VRC_BACKUPS_TOTAL_CHARS,
    MAX_VRC_CONFIG_BACKUP_CHARS,
    canAddVrcBackup,
    embeddableConfigJson,
    fitVrcBackupsToBudget,
    hashVrcBackup,
    isAutoVrcBackup,
    isAutoVrcBackupDue,
    latestVrcBackup,
    pruneAutoVrcBackups,
    verifyVrcBackup
} from '../vrcBackup';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 18, 12);
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toJSON();
const auto = (daysAgo) => ({ name: `Auto Backup ${daysAgo}`, auto: true, date: at(daysAgo) });
const manual = (name, daysAgo) => ({ name, date: at(daysAgo) });

describe('hashVrcBackup / verifyVrcBackup', () => {
    const data = { VRC_FOO: { type: 4, data: 1 } };

    test('hash is stable lowercase sha-256 hex', async () => {
        const hash = await hashVrcBackup(data, '{"a":1}');
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(await hashVrcBackup(data, '{"a":1}')).toBe(hash);
    });

    test('hash changes with registry data or config.json', async () => {
        const hash = await hashVrcBackup(data, '{"a":1}');
        expect(await hashVrcBackup({ ...data, VRC_BAR: 1 }, '{"a":1}')).not.toBe(hash);
        expect(await hashVrcBackup(data, '{"a":2}')).not.toBe(hash);
        expect(await hashVrcBackup(data, undefined)).not.toBe(hash);
    });

    test('accepts an entry whose hash matches', async () => {
        const entry = { data, configJson: '{"a":1}', hash: await hashVrcBackup(data, '{"a":1}') };
        await expect(verifyVrcBackup(entry, true)).resolves.toBeUndefined();
    });

    test('refuses a tampered registry, a tampered config and a dropped config', async () => {
        const hash = await hashVrcBackup(data, '{"a":1}');
        await expect(verifyVrcBackup({ data: { x: 1 }, configJson: '{"a":1}', hash }, false)).rejects.toThrow(
            'hash mismatch'
        );
        await expect(verifyVrcBackup({ data, configJson: '{"a":9}', hash }, false)).rejects.toThrow('hash mismatch');
        await expect(verifyVrcBackup({ data, hash }, false)).rejects.toThrow('hash mismatch');
    });

    test('hashless legacy entries: manual allowed, automatic refused', async () => {
        await expect(verifyVrcBackup({ data }, false)).resolves.toBeUndefined();
        await expect(verifyVrcBackup({ data }, true)).rejects.toThrow('no integrity hash');
    });
});

describe('embeddableConfigJson', () => {
    test('passes small text through, drops empty, missing and oversized', () => {
        expect(embeddableConfigJson('{"a":1}')).toBe('{"a":1}');
        expect(embeddableConfigJson('')).toBeUndefined();
        expect(embeddableConfigJson(null)).toBeUndefined();
        expect(embeddableConfigJson(undefined)).toBeUndefined();
        expect(embeddableConfigJson('x'.repeat(MAX_VRC_CONFIG_BACKUP_CHARS))).toHaveLength(MAX_VRC_CONFIG_BACKUP_CHARS);
        expect(embeddableConfigJson('x'.repeat(MAX_VRC_CONFIG_BACKUP_CHARS + 1))).toBeUndefined();
    });
});

describe('isAutoVrcBackup', () => {
    test('flag, or the legacy bare name', () => {
        expect(isAutoVrcBackup({ auto: true, name: 'x' })).toBe(true);
        expect(isAutoVrcBackup({ name: 'Auto Backup' })).toBe(true);
        expect(isAutoVrcBackup({ name: 'Auto Backup 2026-10-18' })).toBe(false);
        expect(isAutoVrcBackup({ name: 'My backup' })).toBe(false);
    });
});

describe('canAddVrcBackup', () => {
    test('manual backups are capped, automatic ones are not counted against it', () => {
        const full = Array.from({ length: MAX_MANUAL_VRC_BACKUPS }, (_, i) => manual(`m${i}`, i));
        expect(canAddVrcBackup(full.slice(1), false)).toBe(true);
        expect(canAddVrcBackup(full, false)).toBe(false);
        expect(canAddVrcBackup(full, true)).toBe(true);
        expect(canAddVrcBackup([...full.slice(1), auto(1), auto(2)], false)).toBe(true);
    });
});

describe('pruneAutoVrcBackups', () => {
    test('drops automatic backups older than two weeks, keeps manual ones of any age', () => {
        const old = { ...auto(1), date: new Date(NOW - AUTO_VRC_BACKUP_MAX_AGE_MS - 1000).toJSON() };
        const result = pruneAutoVrcBackups([old, manual('ancient', 400), auto(3)], NOW);
        expect(result.map((b) => b.name)).toEqual(['ancient', 'Auto Backup 3']);
    });

    test('keeps at most MAX - 1 automatic backups, dropping the oldest', () => {
        const autos = Array.from({ length: MAX_AUTO_VRC_BACKUPS + 3 }, (_, i) => auto(i % 14));
        const result = pruneAutoVrcBackups(autos, NOW);
        expect(result).toHaveLength(MAX_AUTO_VRC_BACKUPS - 1);
        const newest = autos
            .map((b) => new Date(b.date).getTime())
            .sort((a, b) => b - a)
            .slice(0, MAX_AUTO_VRC_BACKUPS - 1);
        expect(result.map((b) => new Date(b.date).getTime()).sort((a, b) => b - a)).toEqual(newest);
    });

    test('does not depend on array order and never removes manual backups', () => {
        const shuffled = [auto(1), manual('keep', 1), ...Array.from({ length: 12 }, (_, i) => auto(13 - (i % 12)))];
        const result = pruneAutoVrcBackups(shuffled, NOW);
        expect(result.filter((b) => !isAutoVrcBackup(b))).toHaveLength(1);
        expect(result.filter(isAutoVrcBackup)).toHaveLength(MAX_AUTO_VRC_BACKUPS - 1);
    });

    test('does not mutate its input', () => {
        const input = [auto(1), manual('m', 1)];
        pruneAutoVrcBackups(input, NOW);
        expect(input).toHaveLength(2);
    });
});

describe('latestVrcBackup', () => {
    test('picks the newest of any kind, null when empty', () => {
        expect(latestVrcBackup([])).toBeNull();
        const newest = manual('new', 1);
        expect(latestVrcBackup([auto(5), newest, manual('older', 9)])).toBe(newest);
    });
});

describe('isAutoVrcBackupDue', () => {
    test('due with no previous backup, or once a full day has passed', () => {
        expect(isAutoVrcBackupDue(null, NOW)).toBe(true);
        expect(isAutoVrcBackupDue('', NOW)).toBe(true);
        expect(isAutoVrcBackupDue(new Date(NOW - DAY + 1000).toJSON(), NOW)).toBe(false);
        expect(isAutoVrcBackupDue(new Date(NOW - DAY).toJSON(), NOW)).toBe(true);
    });
});

describe('fitVrcBackupsToBudget', () => {
    // ~44K-char registry JSON, like a real backup
    const big = (entry, chars = 44_000) => ({ ...entry, data: { blob: 'x'.repeat(chars) } });
    const size = (list) => JSON.stringify(list).length;

    test('leaves a list that already fits untouched', () => {
        const newest = big(manual('new', 0));
        const list = [auto(2), auto(1), newest];
        expect(fitVrcBackupsToBudget(list, newest)).toEqual(list);
    });

    test('drops the oldest automatic backups first, never the new one or manual ones', () => {
        const keepManual = big(manual('keep', 300));
        const newest = big(auto(0));
        const autos = Array.from({ length: 20 }, (_, i) => big(auto((i % 14) + 1)));
        const result = fitVrcBackupsToBudget([keepManual, ...autos, newest], newest);
        expect(size(result)).toBeLessThanOrEqual(MAX_VRC_BACKUPS_TOTAL_CHARS);
        expect(result).toContain(keepManual);
        expect(result).toContain(newest);
        const dropped = autos.filter((b) => !result.includes(b));
        const survivors = autos.filter((b) => result.includes(b));
        expect(dropped.length).toBeGreaterThan(0);
        // everything dropped is older than everything that survived
        for (const d of dropped) {
            for (const s of survivors) {
                expect(new Date(d.date).getTime()).toBeLessThan(new Date(s.date).getTime());
            }
        }
    });

    test('returns null when only manual backups are left to drop', () => {
        const manuals = Array.from({ length: 6 }, (_, i) => big(manual(`m${i}`, i), 100_000));
        const newest = big(manual('new', 0), 100_000);
        expect(fitVrcBackupsToBudget([...manuals, newest], newest)).toBeNull();
    });

    test('the default count limits fit the budget at realistic sizes', () => {
        const entries = [
            ...Array.from({ length: MAX_AUTO_VRC_BACKUPS }, (_, i) => big(auto(i))),
            ...Array.from({ length: MAX_MANUAL_VRC_BACKUPS }, (_, i) => big(manual(`m${i}`, i)))
        ];
        expect(size(entries)).toBeLessThanOrEqual(MAX_VRC_BACKUPS_TOTAL_CHARS);
        // and the on-wire form (JSON-escaped string) stays under the 1 MiB RPC body limit
        expect(JSON.stringify({ value: JSON.stringify(entries) }).length).toBeLessThan(1024 * 1024);
    });
});
