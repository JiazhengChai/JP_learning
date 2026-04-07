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
const legacyEncryptedFixture = require('./fixtures/encrypted-backup.json');

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

test('encrypted backups are sealed and decrypt successfully', async () => {
    const encryptedBackup = await BackupUtils.encryptBackupData(plainFixture, 'langlens-fixture-passphrase', webcrypto, {
        salt: Uint8Array.from([11, 22, 33, 44, 55, 66, 77, 88, 99, 111, 123, 135, 147, 159, 171, 183]),
        iv: Uint8Array.from([201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212])
    });

    assert.equal(typeof encryptedBackup, 'string');
    assert.match(encryptedBackup, new RegExp(`^${BackupUtils.SEALED_BACKUP_PREFIX}\\.`));
    assert.doesNotMatch(encryptedBackup, /NHK Weather Note|good weather|readingNotes|highlights|sources/);

    const decrypted = await BackupUtils.decryptBackupData(encryptedBackup, 'langlens-fixture-passphrase', webcrypto);

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

test('encrypted backups can omit a passphrase and still restore with a blank one', async () => {
    const encryptedBackup = await BackupUtils.encryptBackupData(plainFixture, '', webcrypto, {
        salt: Uint8Array.from([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31]),
        iv: Uint8Array.from([42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53])
    });

    assert.equal(typeof encryptedBackup, 'string');
    assert.match(encryptedBackup, new RegExp(`^${BackupUtils.SEALED_BACKUP_PREFIX}\.`));

    const decrypted = await BackupUtils.decryptBackupData(encryptedBackup, '', webcrypto);

    assert.equal(decrypted.format, plainFixture.format);
    assert.equal(decrypted.sources[0].title, plainFixture.sources[0].title);
    assert.equal(decrypted.highlights[0].text, plainFixture.highlights[0].text);
    assert.equal(decrypted.readingNotes[0].note, plainFixture.readingNotes[0].note);
});

test('legacy encrypted fixture still decrypts successfully', async () => {
    const decrypted = await BackupUtils.decryptBackupData(legacyEncryptedFixture, 'langlens-fixture-passphrase', webcrypto);

    assert.equal(decrypted.format, plainFixture.format);
    assert.equal(decrypted.sources[0].title, plainFixture.sources[0].title);
    assert.equal(decrypted.highlights[0].note, plainFixture.highlights[0].note);
    assert.equal(decrypted.readingNotes[0].text, plainFixture.readingNotes[0].text);
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

test('backup filename helper recognizes rolling and timestamped backups', () => {
    const latest = BackupUtils.parseBackupFileName('langlens-latest-backup-encrypted.json');
    const snapshot = BackupUtils.parseBackupFileName('langlens-backup-2026-04-07_10-20-30Z.json');

    assert.deepEqual(latest, {
        name: 'langlens-latest-backup-encrypted.json',
        kind: 'latest',
        stamp: '',
        encrypted: true
    });
    assert.deepEqual(snapshot, {
        name: 'langlens-backup-2026-04-07_10-20-30Z.json',
        kind: 'snapshot',
        stamp: '2026-04-07_10-20-30Z',
        encrypted: false
    });
    assert.equal(BackupUtils.parseBackupFileName('notes.json'), null);
});

test('backup filename helper prefers the rolling latest encrypted backup first', () => {
    const choice = BackupUtils.pickPreferredBackupFile([
        { name: 'langlens-backup-2026-04-07_10-20-30Z-encrypted.json', lastModified: 100 },
        { name: 'langlens-latest-backup.json', lastModified: 200 },
        { name: 'langlens-latest-backup-encrypted.json', lastModified: 150 }
    ]);

    assert.equal(choice.name, 'langlens-latest-backup-encrypted.json');
});

test('backup filename helper falls back to the newest snapshot when no rolling file exists', () => {
    const choice = BackupUtils.pickPreferredBackupFile([
        { name: 'langlens-backup-2026-04-07_08-20-30Z-encrypted.json', lastModified: 500 },
        { name: 'langlens-backup-2026-04-07_10-20-30Z.json', lastModified: 100 },
        { name: 'langlens-backup-2026-04-07_09-20-30Z-encrypted.json', lastModified: 900 }
    ]);

    assert.equal(choice.name, 'langlens-backup-2026-04-07_10-20-30Z.json');
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

test('clearLibraryData removes sources, highlights, and reading notes but keeps settings', async () => {
    const db = await freshDatabase();
    const sourceId = await db.addSource({
        title: 'Article with image',
        content: 'Example content',
        imageUrl: 'https://example.com/cover.jpg',
        sourceType: 'article',
        language: 'Japanese'
    });

    await db.addHighlight({
        sourceId,
        text: '気になる',
        note: 'to catch one\'s attention',
        category: 'vocab'
    });
    await db.addReadingNote({
        sourceId,
        text: '気になる',
        note: 'Important nuance'
    });
    await db.setSetting('backup-reminder-days', 21);

    await db.clearLibraryData();

    assert.equal((await db.getAllSources()).length, 0);
    assert.equal((await db.getAllHighlights()).length, 0);
    assert.equal((await db.getAllReadingNotes()).length, 0);
    assert.equal(await db.getSetting('backup-reminder-days'), 21);

    db.db.close();
});

test('source imageUrl is normalized and included in exports', async () => {
    const db = await freshDatabase();
    await db.addSource({
        title: 'NHK article',
        content: 'Body text',
        imageUrl: '  https://example.com/article.jpg  ',
        sourceType: 'article',
        language: 'Japanese'
    });

    const [source] = await db.getAllSources();
    const exported = await db.exportAll();

    assert.equal(source.imageUrl, 'https://example.com/article.jpg');
    assert.equal(exported.sources[0].imageUrl, 'https://example.com/article.jpg');

    db.db.close();
});

test('source content is normalized to LF on read and export', async () => {
    const db = await freshDatabase();
    const sourceId = await db.addSource({
        title: 'Line endings',
        content: 'First line\r\nSecond line\r\nThird line',
        sourceType: 'article',
        language: 'Japanese'
    });

    const source = await db.getSource(sourceId);
    const [listed] = await db.getAllSources();
    const exported = await db.exportAll();

    assert.equal(source.content, 'First line\nSecond line\nThird line');
    assert.equal(listed.content, 'First line\nSecond line\nThird line');
    assert.equal(exported.sources[0].content, 'First line\nSecond line\nThird line');

    db.db.close();
});

test('clearSourceAnnotationOffsets keeps linked records but removes inline positions', async () => {
    const db = await freshDatabase();
    const sourceId = await db.addSource({
        title: 'Editable article',
        content: 'Original body text',
        sourceType: 'article',
        language: 'Japanese'
    });
    const highlightId = await db.addHighlight({
        sourceId,
        text: 'Original',
        note: 'saved item',
        startOffset: 0,
        endOffset: 8
    });
    const noteId = await db.addReadingNote({
        sourceId,
        text: 'body',
        note: 'reading note',
        startOffset: 9,
        endOffset: 13
    });

    await db.clearSourceAnnotationOffsets(sourceId);

    const highlight = await db.getHighlight(highlightId);
    const notes = await db.getReadingNotesBySource(sourceId);
    const note = notes.find(entry => entry.id === noteId);

    assert.equal(highlight.sourceId, sourceId);
    assert.equal(highlight.startOffset, null);
    assert.equal(highlight.endOffset, null);
    assert.equal(note.sourceId, sourceId);
    assert.equal(note.startOffset, null);
    assert.equal(note.endOffset, null);

    db.db.close();
});