const test = require('node:test');
const assert = require('node:assert/strict');
const { indexedDB } = require('fake-indexeddb');
globalThis.indexedDB = indexedDB;
globalThis.SyncCore = require('../js/sync-core.js');
const { Database } = require('../js/db.js');
globalThis.Database = Database;
const CloudSync = require('../js/cloud-sync.js');
const { empty, merge, changes, apply } = SyncCore;
const library = (...rows) => ({ ...empty(), highlights: rows });

test('independent offline changes from two devices both survive', () => {
    const base = library({ id: 1, note: 'a' }, { id: 2, note: 'b' });
    const local = library({ id: 1, note: 'local' }, base.highlights[1]);
    const remote = library(base.highlights[0], { id: 2, note: 'remote' });
    const result = merge(base, local, remote);
    assert.equal(result.conflicts.length, 0);
    assert.deepEqual(result.data, library(local.highlights[0], remote.highlights[1]));
});

test('stale device does not resurrect a cloud deletion', () => {
    const base = library({ id: 1, note: 'a' });
    assert.deepEqual(merge(base, base, empty()).data, empty());
});

test('edit versus deletion and competing edits require a decision', () => {
    const base = library({ id: 1, note: 'original' });
    const local = library({ id: 1, note: 'offline edit' });
    for (const remote of [empty(), library({ id: 1, note: 'other device' })]) {
        const result = merge(base, local, remote);
        assert.equal(result.conflicts.length, 1);
        assert.deepEqual(result.data, local);
    }
});

test('resolution cannot overwrite edits made after the conflict was reviewed', () => {
    const base = library({ id: 1, note: 'original' });
    const local = library({ id: 1, note: 'local' });
    const remote = library({ id: 1, note: 'remote' });
    const conflict = merge(base, local, remote).conflicts[0];
    const resolutions = { 'highlights/1': { ...conflict, choice: 'remote' } };
    assert.deepEqual(merge(base, local, remote, resolutions).data, remote);
    assert.equal(merge(base, library({ id: 1, note: 'new edit' }), remote, resolutions).conflicts.length, 1);
});

test('partial uploads leave unsent edits queued', () => {
    const remote = empty();
    const local = library(...Array.from({ length: 900 }, (_, id) => ({ id, note: String(id) })));
    const published = apply(remote, changes(remote, local).slice(0, 400));
    assert.equal(changes(published, local).length, 500);
    assert.equal(merge(published, local, published).conflicts.length, 0);
});

test('attachment transport metadata does not create false conflicts', () => {
    const base = library({ id: 1, fileDataUrl: 'data:test' });
    const remote = library({ ...base.highlights[0], cloudAttachment: { path: 'some/path' } });
    assert.equal(changes(base, remote).length, 0);
});

test('source deletion versus a newly added offline note requires explicit resolution', () => {
    const source = { id: 1, title: 'source' };
    const base = { ...empty(), sources: [source] };
    const local = { ...base, readingNotes: [{ id: 2, sourceId: 1, note: 'offline note' }] };
    const remote = empty();
    const result = merge(base, local, remote);
    assert.equal(result.conflicts.length, 1);
    const conflict = result.conflicts[0];
    const restored = merge(base, local, remote, { 'sources/1': { ...conflict, choice: 'local' } });
    assert.equal(restored.data.sources.length, 1);
    assert.equal(restored.data.readingNotes.length, 1);
    const deleted = merge(base, local, remote, { 'sources/1': { ...conflict, choice: 'remote' } });
    assert.deepEqual(deleted.data, empty());
});

test('account databases are isolated and new IDs do not collide between devices', async () => {
    const a = new Database(`test-a-${crypto.randomUUID()}`, true);
    const b = new Database(`test-b-${crypto.randomUUID()}`, true);
    await Promise.all([a.init(), b.init()]);
    try {
        const aId = await a.addSource({ title: 'A' });
        const bId = await b.addSource({ title: 'B' });
        assert.notEqual(aId, bId);
        assert.equal(Number.isSafeInteger(aId), true);
        assert.equal((await a.getAllSources())[0].title, 'A');
        assert.equal((await b.getAllSources())[0].title, 'B');
        assert.equal(await b.getSource(aId), undefined);
    } finally { a.db.close(); b.db.close(); }
});

test('acknowledgment preserves edits and deletes made during upload, persists base across reload', async () => {
    const name = `test-ack-${crypto.randomUUID()}`;
    const db = new Database(name, true);
    await db.init();
    const id = await db.addHighlight({ text: 'before' });
    const deleted = await db.addHighlight({ text: 'will delete' });
    const captured = await db.readSyncSnapshot();
    await db.updateHighlight({ ...(await db.getHighlight(id)), text: 'edited during upload' });
    await db.deleteHighlight(deleted);
    const merged = { ...captured.data, sources: [{ id: 99, title: 'from other device' }] };
    const state = { revision: 1, data: merged };
    await db.acknowledgeSync(captured.data, merged, state);
    assert.equal((await db.getHighlight(id)).text, 'edited during upload');
    assert.equal(await db.getHighlight(deleted), undefined);
    assert.equal((await db.getSource(99)).title, 'from other device');
    db.db.close();
    const reloaded = new Database(name, true);
    await reloaded.init();
    try {
        const snapshot = await reloaded.readSyncSnapshot();
        assert.equal(snapshot.state.revision, 1);
        assert.equal(changes(snapshot.state.data, snapshot.data).length, 2);
    } finally { reloaded.db.close(); }
});

test('cloud merge import remaps source references to fresh device-safe IDs', async () => {
    const db = new Database(`test-import-${crypto.randomUUID()}`, true);
    await db.init();
    try {
        await db.importAll({ sources: [{ id: 1, title: 'Guest' }], highlights: [{ id: 1, sourceId: 1, text: 'item' }], readingNotes: [] }, { mode: 'merge' });
        const [source] = await db.getAllSources();
        const [highlight] = await db.getAllHighlights();
        assert.notEqual(source.id, 1);
        assert.equal(highlight.sourceId, source.id);
        assert.equal(db.syncBusy, 0);
    } finally { db.db.close(); }
});

test('invalid replacement backup rolls back without clearing existing progress', async () => {
    const db = new Database(`test-rollback-${crypto.randomUUID()}`, true);
    await db.init();
    try {
        const id = await db.addHighlight({ text: 'keep me' });
        await assert.rejects(db.importAll({ sources: [], highlights: [{ id: {}, text: 'invalid key' }], readingNotes: [] }));
        assert.equal((await db.getHighlight(id)).text, 'keep me');
    } finally { db.db.close(); }
});

function memoryFirestore() {
    const records = new Map();
    let revision = 0;
    return {
        records,
        doc: (_, ...parts) => parts.join('/'),
        collection: (_, ...parts) => parts.join('/'),
        getDocFromServer: async () => ({ data: () => ({ revision }) }),
        getDocsFromServer: async path => ({ docs: [...records].filter(([key]) => key.startsWith(`${path}/`)).map(([key, value]) => ({ id: key.split('/').pop(), data: () => value })) }),
        serverTimestamp: () => 1,
        runTransaction: async (_, action) => {
            const writes = [];
            await action({
                get: async () => ({ data: () => ({ revision }) }),
                set: (ref, value) => writes.push(() => { if (ref.endsWith('/sync/state')) revision = value.revision; else records.set(ref, value); }),
                delete: ref => writes.push(() => records.delete(ref))
            });
            writes.forEach(write => write());
        }
    };
}

async function device(server) {
    const db = new Database(`device-${crypto.randomUUID()}`, true);
    await db.init();
    const app = { db, currentView: 'dashboard', isModalOpen: () => false, updateReviewBadge: async () => {}, navigate: async () => {}, showToast: () => {} };
    const sync = new CloudSync(app);
    sync.user = { uid: 'test-user' };
    sync.auth = { currentUser: sync.user };
    sync.fs = server;
    sync.meta = 'users/test-user/sync/state';
    sync.render = () => {};
    sync.schedule = () => {};
    sync.fail = error => { sync.lastError = error; };
    return sync;
}

test('two full sync clients upload, restore, merge offline edits, and propagate deletions', async () => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true, locks: { request: async (_, action) => action() } } });
    const server = memoryFirestore();
    const a = await device(server);
    const b = await device(server);
    try {
        const id = await a.app.db.addHighlight({ text: 'original' });
        await a.sync();
        await b.sync();
        assert.equal((await b.app.db.getHighlight(id)).text, 'original');
        navigator.onLine = false;
        await b.app.db.updateHighlight({ ...(await b.app.db.getHighlight(id)), text: 'offline edit' });
        await b.sync();
        assert.match(b.message, /Offline/);
        const second = await a.app.db.addHighlight({ text: 'independent addition' });
        navigator.onLine = true;
        await a.sync();
        await b.sync();
        await a.sync();
        assert.equal((await a.app.db.getHighlight(id)).text, 'offline edit');
        assert.equal((await b.app.db.getHighlight(second)).text, 'independent addition');
        await a.app.db.deleteHighlight(id);
        await a.sync();
        await b.sync();
        assert.equal(await b.app.db.getHighlight(id), undefined);
        assert.equal(a.lastError, undefined);
        assert.equal(b.lastError, undefined);
    } finally { a.app.db.db.close(); b.app.db.db.close(); }
});

test('incoming sync waits for open editors, then exposes competing edits without overwriting', async () => {
    const server = memoryFirestore();
    const a = await device(server);
    const b = await device(server);
    try {
        const id = await a.app.db.addHighlight({ text: 'original' });
        await a.sync(); await b.sync();
        await a.app.db.updateHighlight({ ...(await a.app.db.getHighlight(id)), text: 'remote edit' });
        await a.sync();
        b.app.isModalOpen = () => true;
        await b.sync();
        assert.equal((await b.app.db.getHighlight(id)).text, 'original');
        await b.app.db.updateHighlight({ ...(await b.app.db.getHighlight(id)), text: 'local edit' });
        b.app.isModalOpen = () => false;
        await b.sync();
        assert.equal(b.conflicts.length, 1);
        assert.equal((await b.app.db.getHighlight(id)).text, 'local edit');
        assert.equal((await a.app.db.getHighlight(id)).text, 'remote edit');
    } finally { a.app.db.db.close(); b.app.db.db.close(); }
});

test('empty cloud does not claim saved progress; first sign-in migrates guest progress only once', async () => {
    const server = memoryFirestore();
    const a = await device(server);
    const guest = new Database();
    await guest.init();
    try {
        await a.sync();
        assert.match(a.message, /Cloud library is empty/);
        const guestSource = await guest.addSource({ title: 'Original library' });
        await guest.addHighlight({ sourceId: guestSource, text: 'Original progress', reviewCount: 7 });
        await a.sync();
        assert.equal(a.lastError, undefined);
        assert.match(a.message, /Saved to cloud · 1 items, 1 sources/);
        const [item] = await a.app.db.getAllHighlights();
        assert.equal(item.reviewCount, 7);
        assert.equal((await guest.getAllHighlights()).length, 1);
        await a.app.db.clearLibraryData();
        await a.sync();
        assert.equal((await a.app.db.getAllHighlights()).length, 0);
        const b = await device(memoryFirestore());
        try {
            b.user = { uid: 'another-user' }; b.auth.currentUser = b.user;
            await b.sync();
            assert.equal((await b.app.db.getAllHighlights()).length, 0);
        } finally { b.app.db.db.close(); }
    } finally {
        await guest.clearLibraryData();
        await guest.deleteSetting('cloud-migrated-account');
        guest.db.close(); a.app.db.db.close();
    }
});

test('file upload failure preserves local source and linked progress, then retries when storage is enabled', async () => {
    const server = memoryFirestore();
    const a = await device(server);
    const b = await device(server);
    const objects = new Map();
    const sdk = {
        ref: (_, path) => path,
        getMetadata: async path => { if (!objects.has(path)) throw { code: 'storage/object-not-found' }; return {}; },
        uploadBytes: async (path, blob) => { objects.set(path, new Uint8Array(await blob.arrayBuffer())); },
        getBytes: async path => objects.get(path)
    };
    const previousReader = globalThis.FileReader;
    globalThis.FileReader = class {
        async readAsDataURL(blob) {
            this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
            this.onload();
        }
    };
    try {
        const fileDataUrl = 'data:application/pdf;base64,JVBERi10ZXN0';
        const id = await a.app.db.addSource({ title: 'Attachment', fileDataUrl });
        await a.app.db.addHighlight({ sourceId: id, text: 'Linked review', reviewCount: 3 });
        await a.sync();
        assert.match(a.message, /2 records still local/);
        assert.equal((await a.app.db.getSource(id)).fileDataUrl, fileDataUrl);
        assert.equal(server.records.size, 0);
        for (const client of [a, b]) { client.storage = {}; client.storageSDK = sdk; }
        await a.sync(); await b.sync();
        assert.equal(a.lastError, undefined); assert.equal(b.lastError, undefined);
        assert.equal((await b.app.db.getSource(id)).fileDataUrl, fileDataUrl);
        assert.equal((await b.app.db.getAllHighlights())[0].reviewCount, 3);
        assert.equal(objects.size, 1);
        assert.equal(JSON.parse(server.records.get(`users/test-user/sources/${id}`).payload).fileDataUrl, '');
        await b.app.db.updateSource({ ...(await b.app.db.getSource(id)), title: 'Edited remotely' });
        await b.sync(); await a.sync();
        assert.equal((await a.app.db.getSource(id)).fileDataUrl, fileDataUrl);
        assert.equal((await a.app.db.getSource(id)).title, 'Edited remotely');
        assert.equal(objects.size, 1);
    } finally {
        globalThis.FileReader = previousReader;
        a.app.db.db.close(); b.app.db.db.close();
    }
});
