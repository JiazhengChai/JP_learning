const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { indexedDB, IDBKeyRange } = require('fake-indexeddb');

globalThis.crypto = webcrypto;
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const { Database, DB_NAME } = require('../js/db.js');
const BackupUtils = require('../js/backup-utils.js');
const plainFixture = require('./fixtures/plain-backup.json');
const encryptedFixture = require('./fixtures/encrypted-backup.json');

async function deleteDatabase(name) {
    await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => resolve();
    });
}

async function freshDatabase() {
    await deleteDatabase(DB_NAME);
    const db = new Database();
    await db.init();
    return db;
}

async function createLegacyV3Database() {
    await deleteDatabase(DB_NAME);
    await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 3);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('sources')) {
                const sources = db.createObjectStore('sources', { keyPath: 'id', autoIncrement: true });
                sources.createIndex('createdAt', 'createdAt');
                sources.createIndex('sourceType', 'sourceType');
                sources.createIndex('language', 'language');
            }
            if (!db.objectStoreNames.contains('highlights')) {
                const highlights = db.createObjectStore('highlights', { keyPath: 'id', autoIncrement: true });
                highlights.createIndex('sourceId', 'sourceId');
                highlights.createIndex('createdAt', 'createdAt');
                highlights.createIndex('nextReviewAt', 'nextReviewAt');
                highlights.createIndex('type', 'type');
                highlights.createIndex('masteryLevel', 'masteryLevel');
                highlights.createIndex('category', 'category');
                highlights.createIndex('charCount', 'charCount');
                highlights.createIndex('updatedAt', 'updatedAt');
            }
            if (!db.objectStoreNames.contains('readingNotes')) {
                const notes = db.createObjectStore('readingNotes', { keyPath: 'id', autoIncrement: true });
                notes.createIndex('sourceId', 'sourceId');
                notes.createIndex('createdAt', 'createdAt');
            }
        };
        request.onsuccess = () => {
            request.result.close();
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
}

test('plain fixture imports and exports cleanly in replace mode', async () => {
    const db = await freshDatabase();
    const result = await db.importAll(plainFixture, { mode: 'replace' });

    assert.equal(result.mode, 'replace');
    assert.equal(result.sources.added, 1);
    assert.equal(result.highlights.added, 1);
    assert.equal(result.readingNotes.added, 1);

    const exported = await db.exportAll();
    assert.equal(exported.counts.sources, 1);
    assert.equal(exported.counts.highlights, 1);
    assert.equal(exported.counts.readingNotes, 1);
    assert.equal(exported.sources[0].title, plainFixture.sources[0].title);
    assert.equal(exported.highlights[0].text, plainFixture.highlights[0].text);
    assert.equal(exported.readingNotes[0].note, plainFixture.readingNotes[0].note);

    db.db.close();
});

test('merge mode skips duplicate records from the same plain fixture', async () => {
    const db = await freshDatabase();
    await db.importAll(plainFixture, { mode: 'replace' });
    const result = await db.importAll(plainFixture, { mode: 'merge' });
    const exported = await db.exportAll();

    assert.equal(result.mode, 'merge');
    assert.equal(result.sources.added, 0);
    assert.equal(result.highlights.added, 0);
    assert.equal(result.readingNotes.added, 0);
    assert.ok(result.sources.skipped >= 1);
    assert.ok(result.highlights.skipped >= 1);
    assert.ok(result.readingNotes.skipped >= 1);
    assert.equal(exported.sources.length, 1);
    assert.equal(exported.highlights.length, 1);
    assert.equal(exported.readingNotes.length, 1);

    db.db.close();
});

test('settings store persists structured values for backup preferences', async () => {
    const db = await freshDatabase();
    await db.setSetting('backup-folder-handle', { name: 'OneDriveBackups', mode: 'readwrite' });
    await db.setSetting('backup-reminder-days', 14);

    const stored = await db.getSetting('backup-folder-handle');
    assert.deepEqual(stored, { name: 'OneDriveBackups', mode: 'readwrite' });
    assert.equal(await db.getSetting('backup-reminder-days'), 14);

    await db.deleteSetting('backup-folder-handle');
    const cleared = await db.getSetting('backup-folder-handle');
    assert.equal(cleared, null);

    db.db.close();
});

test('encrypted fixture decrypts and restores successfully', async () => {
    const decrypted = await BackupUtils.decryptBackupData(encryptedFixture, 'langlens-fixture-passphrase', webcrypto);

    assert.equal(decrypted.format, plainFixture.format);
    assert.equal(decrypted.sources[0].title, plainFixture.sources[0].title);
    assert.equal(decrypted.highlights[0].note, plainFixture.highlights[0].note);
    assert.equal(decrypted.readingNotes[0].text, plainFixture.readingNotes[0].text);

    const db = await freshDatabase();
    await db.importAll(decrypted, { mode: 'replace' });
    const exported = await db.exportAll();

    assert.equal(exported.counts.sources, 1);
    assert.equal(exported.sources[0].title, plainFixture.sources[0].title);

    db.db.close();
});

test('backup reminder helper flags missing and stale backups only when there is data', () => {
    const missing = BackupUtils.getBackupReminder({ totalSources: 1, lastBackupAt: 0, now: 10_000 });
    const stale = BackupUtils.getBackupReminder({
        totalSources: 1,
        lastBackupAt: 10_000,
        now: 10_000 + BackupUtils.DEFAULT_BACKUP_THRESHOLD_MS + 1
    });
    const fresh = BackupUtils.getBackupReminder({
        totalSources: 1,
        lastBackupAt: 10_000,
        now: 10_000 + BackupUtils.DEFAULT_BACKUP_THRESHOLD_MS - 1
    });
    const empty = BackupUtils.getBackupReminder({ totalSources: 0, totalHighlights: 0, lastBackupAt: 0, now: 10_000 });

    assert.equal(missing.kind, 'missing');
    assert.equal(missing.shouldShow, true);
    assert.equal(stale.kind, 'stale');
    assert.equal(stale.shouldShow, true);
    assert.equal(fresh.shouldShow, false);
    assert.equal(empty.shouldShow, false);
});

test('upgrading a legacy v3 database creates a migration notice setting', async () => {
    await createLegacyV3Database();

    const db = new Database();
    await db.init();
    const notice = await db.getSetting('migration-notice');

    assert.equal(notice.fromVersion, 3);
    assert.equal(notice.toVersion, 5);
    assert.equal(notice.kind, 'backup-upgrade');

    db.db.close();
});