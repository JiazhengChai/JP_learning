/**
 * LangLens - IndexedDB Data Layer
 * Stores imported sources and saved study items.
 */

const DB_NAME = 'LangLensDB';
const DB_VERSION = 5;
const BACKUP_FORMAT = 'langlens-backup';
const BACKUP_VERSION = 1;

class Database {
    constructor() {
        this.db = null;
    }

    init() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);

            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                const tx = e.target.transaction;
                const oldVersion = e.oldVersion || 0;

                if (!db.objectStoreNames.contains('sources')) {
                    const sourceStore = db.createObjectStore('sources', { keyPath: 'id', autoIncrement: true });
                    sourceStore.createIndex('createdAt', 'createdAt');
                    sourceStore.createIndex('sourceType', 'sourceType');
                    sourceStore.createIndex('language', 'language');
                }

                let highlightStore;
                if (!db.objectStoreNames.contains('highlights')) {
                    highlightStore = db.createObjectStore('highlights', { keyPath: 'id', autoIncrement: true });
                    highlightStore.createIndex('sourceId', 'sourceId');
                    highlightStore.createIndex('createdAt', 'createdAt');
                    highlightStore.createIndex('nextReviewAt', 'nextReviewAt');
                    highlightStore.createIndex('type', 'type');
                    highlightStore.createIndex('masteryLevel', 'masteryLevel');
                } else {
                    highlightStore = tx.objectStore('highlights');
                }

                if (!highlightStore.indexNames.contains('category')) {
                    highlightStore.createIndex('category', 'category');
                }
                if (!highlightStore.indexNames.contains('charCount')) {
                    highlightStore.createIndex('charCount', 'charCount');
                }
                if (!highlightStore.indexNames.contains('updatedAt')) {
                    highlightStore.createIndex('updatedAt', 'updatedAt');
                }

                if (!db.objectStoreNames.contains('readingNotes')) {
                    const notesStore = db.createObjectStore('readingNotes', { keyPath: 'id', autoIncrement: true });
                    notesStore.createIndex('sourceId', 'sourceId');
                    notesStore.createIndex('createdAt', 'createdAt');
                }

                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'key' });
                }

                if (oldVersion > 0 && oldVersion < DB_VERSION) {
                    const settingsStore = tx.objectStore('settings');
                    settingsStore.put({
                        key: 'migration-notice',
                        value: {
                            fromVersion: oldVersion,
                            toVersion: DB_VERSION,
                            createdAt: Date.now(),
                            kind: 'backup-upgrade'
                        },
                        updatedAt: Date.now()
                    });
                }
            };

            req.onsuccess = (e) => {
                this.db = e.target.result;
                resolve();
            };

            req.onerror = (e) => reject(e.target.error);
        });
    }

    _store(name, mode) {
        const tx = this.db.transaction(name, mode);
        return tx.objectStore(name);
    }

    _req(store, method, ...args) {
        return new Promise((resolve, reject) => {
            const r = store[method](...args);
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
    }

    _normalizeCategory(value, tags = []) {
        const raw = typeof value === 'string' ? value.trim() : '';
        if (raw) return raw;
        if (Array.isArray(tags) && tags.length > 0) {
            const firstTag = String(tags[0] || '').trim();
            if (firstTag) return firstTag;
        }
        return 'vocab';
    }

    _normalizeHighlight(highlight = {}, opts = {}) {
        const text = String(highlight.text || '').trim();
        const note = String(highlight.note || highlight.reading || '').trim();
        const createdAt = highlight.createdAt || Date.now();
        const updatedAt = opts.touch ? Date.now() : (highlight.updatedAt || createdAt);
        const category = this._normalizeCategory(highlight.category, highlight.tags);

        return {
            ...highlight,
            text,
            note,
            type: highlight.type || 'vocab',
            category,
            createdAt,
            updatedAt,
            masteryLevel: Number.isFinite(highlight.masteryLevel) ? highlight.masteryLevel : 0,
            easeFactor: Number.isFinite(highlight.easeFactor) ? highlight.easeFactor : 2.5,
            interval: Number.isFinite(highlight.interval) ? highlight.interval : 0,
            nextReviewAt: Number.isFinite(highlight.nextReviewAt) ? highlight.nextReviewAt : 0,
            lastReviewedAt: Number.isFinite(highlight.lastReviewedAt) ? highlight.lastReviewedAt : 0,
            reviewCount: Number.isFinite(highlight.reviewCount) ? highlight.reviewCount : 0,
            charCount: Number.isFinite(highlight.charCount) ? highlight.charCount : text.length,
            noteLength: Number.isFinite(highlight.noteLength) ? highlight.noteLength : note.length,
            tags: Array.isArray(highlight.tags) ? highlight.tags.filter(Boolean) : []
        };
    }

    _normalizeSource(source = {}, opts = {}) {
        return {
            ...source,
            createdAt: source.createdAt || Date.now(),
            updatedAt: opts.touch ? Date.now() : (source.updatedAt || source.createdAt || Date.now()),
            tags: Array.isArray(source.tags) ? source.tags.filter(Boolean) : []
        };
    }

    _normalizeReadingNote(note = {}) {
        return {
            ...note,
            text: String(note.text || '').trim(),
            note: String(note.note || '').trim(),
            color: String(note.color || 'yellow').trim() || 'yellow',
            createdAt: note.createdAt || Date.now()
        };
    }

    _mergeTags(left = [], right = []) {
        return [...new Set([
            ...(Array.isArray(left) ? left : []),
            ...(Array.isArray(right) ? right : [])
        ].map(tag => String(tag || '').trim()).filter(Boolean))];
    }

    _sourceFingerprint(source = {}) {
        return [
            String(source.title || '').trim().toLowerCase(),
            String(source.content || '').trim().toLowerCase(),
            String(source.sourceType || 'other').trim().toLowerCase(),
            String(source.language || '').trim().toLowerCase()
        ].join('::');
    }

    _sourceKeyForId(sourceId, sourceKeyById) {
        if (!Number.isFinite(sourceId)) return 'manual';
        return sourceKeyById.get(sourceId) || `source:${sourceId}`;
    }

    _highlightFingerprint(highlight = {}, sourceKey = 'manual') {
        return [
            sourceKey,
            Number.isFinite(highlight.startOffset) ? highlight.startOffset : '',
            Number.isFinite(highlight.endOffset) ? highlight.endOffset : '',
            Number.isFinite(highlight.createdAt) ? highlight.createdAt : '',
            String(highlight.text || '').trim().toLowerCase()
        ].join('::');
    }

    _readingNoteFingerprint(note = {}, sourceKey = 'manual') {
        return [
            sourceKey,
            Number.isFinite(note.startOffset) ? note.startOffset : '',
            Number.isFinite(note.endOffset) ? note.endOffset : '',
            Number.isFinite(note.createdAt) ? note.createdAt : '',
            String(note.text || '').trim().toLowerCase(),
            String(note.note || '').trim().toLowerCase()
        ].join('::');
    }

    _normalizeBackupPayload(data) {
        if (!data || !Array.isArray(data.sources) || !Array.isArray(data.highlights)) {
            throw new Error('Invalid import data format');
        }

        return {
            format: data.format || BACKUP_FORMAT,
            backupVersion: data.backupVersion || 0,
            schemaVersion: data.schemaVersion || data.version || DB_VERSION,
            exportedAt: data.exportedAt || Date.now(),
            sources: data.sources,
            highlights: data.highlights,
            readingNotes: Array.isArray(data.readingNotes) ? data.readingNotes : []
        };
    }

    _clearStore(name) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(name, 'readwrite');
            const req = tx.objectStore(name).clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async _addRecord(name, record) {
        const store = this._store(name, 'readwrite');
        const next = { ...record };
        delete next.id;
        return this._req(store, 'add', next);
    }

    async _putRecord(name, record) {
        const store = this._store(name, 'readwrite');
        return this._req(store, 'put', record);
    }

    _mergeSourceRecord(existing, incoming) {
        const createdAt = Math.min(existing.createdAt || Number.MAX_SAFE_INTEGER, incoming.createdAt || Number.MAX_SAFE_INTEGER);
        return this._normalizeSource({
            ...existing,
            ...incoming,
            id: existing.id,
            createdAt: Number.isFinite(createdAt) ? createdAt : (incoming.createdAt || existing.createdAt || Date.now()),
            updatedAt: Math.max(existing.updatedAt || 0, incoming.updatedAt || 0),
            tags: this._mergeTags(existing.tags, incoming.tags)
        });
    }

    _mergeHighlightRecord(existing, incoming) {
        const createdAt = Math.min(existing.createdAt || Number.MAX_SAFE_INTEGER, incoming.createdAt || Number.MAX_SAFE_INTEGER);
        return this._normalizeHighlight({
            ...existing,
            ...incoming,
            id: existing.id,
            sourceId: Number.isFinite(incoming.sourceId) ? incoming.sourceId : existing.sourceId,
            createdAt: Number.isFinite(createdAt) ? createdAt : (incoming.createdAt || existing.createdAt || Date.now()),
            updatedAt: Math.max(existing.updatedAt || 0, incoming.updatedAt || 0),
            lastReviewedAt: Math.max(existing.lastReviewedAt || 0, incoming.lastReviewedAt || 0),
            nextReviewAt: Math.max(existing.nextReviewAt || 0, incoming.nextReviewAt || 0),
            reviewCount: Math.max(existing.reviewCount || 0, incoming.reviewCount || 0),
            masteryLevel: Math.max(existing.masteryLevel || 0, incoming.masteryLevel || 0),
            interval: Math.max(existing.interval || 0, incoming.interval || 0),
            easeFactor: Math.max(existing.easeFactor || 0, incoming.easeFactor || 0),
            tags: this._mergeTags(existing.tags, incoming.tags)
        });
    }

    _mapImportedSourceId(sourceId, sourceIdMap) {
        if (!Number.isFinite(sourceId)) return null;
        return sourceIdMap.get(sourceId) || null;
    }

    async addSource(source) {
        const store = this._store('sources', 'readwrite');
        return this._req(store, 'add', this._normalizeSource(source, { touch: true }));
    }

    async getSource(id) {
        const store = this._store('sources', 'readonly');
        return this._req(store, 'get', id);
    }

    async getAllSources() {
        const store = this._store('sources', 'readonly');
        return this._req(store, 'getAll');
    }

    async updateSource(source) {
        const store = this._store('sources', 'readwrite');
        return this._req(store, 'put', this._normalizeSource(source, { touch: true }));
    }

    async deleteSource(id) {
        const sourceStore = this._store('sources', 'readwrite');
        await this._req(sourceStore, 'delete', id);

        const highlights = await this.getHighlightsBySource(id);
        if (highlights.length > 0) {
            const highlightStore = this._store('highlights', 'readwrite');
            for (const highlight of highlights) {
                highlightStore.delete(highlight.id);
            }
        }

        const notes = await this.getReadingNotesBySource(id);
        if (notes.length > 0) {
            const notesStore = this._store('readingNotes', 'readwrite');
            for (const note of notes) {
                notesStore.delete(note.id);
            }
        }
    }

    async addHighlight(highlight) {
        const store = this._store('highlights', 'readwrite');
        return this._req(store, 'add', this._normalizeHighlight(highlight, { touch: true }));
    }

    async getHighlight(id) {
        const store = this._store('highlights', 'readonly');
        const highlight = await this._req(store, 'get', id);
        return highlight ? this._normalizeHighlight(highlight) : highlight;
    }

    async getAllHighlights() {
        const store = this._store('highlights', 'readonly');
        const highlights = await this._req(store, 'getAll');
        return highlights.map(highlight => this._normalizeHighlight(highlight));
    }

    async getHighlightsBySource(sourceId) {
        return new Promise((resolve, reject) => {
            const store = this._store('highlights', 'readonly');
            const idx = store.index('sourceId');
            const req = idx.getAll(sourceId);
            req.onsuccess = () => resolve(req.result.map(highlight => this._normalizeHighlight(highlight)));
            req.onerror = () => reject(req.error);
        });
    }

    async getDueHighlights() {
        const all = await this.getAllHighlights();
        const now = Date.now();
        return all.filter(highlight => !highlight.nextReviewAt || highlight.nextReviewAt <= now);
    }

    async updateHighlight(highlight) {
        const store = this._store('highlights', 'readwrite');
        return this._req(store, 'put', this._normalizeHighlight(highlight, { touch: true }));
    }

    async deleteHighlight(id) {
        const store = this._store('highlights', 'readwrite');
        return this._req(store, 'delete', id);
    }

    // === Reading Notes ===
    async addReadingNote(note) {
        const store = this._store('readingNotes', 'readwrite');
        return this._req(store, 'add', this._normalizeReadingNote(note));
    }

    async getReadingNotesBySource(sourceId) {
        return new Promise((resolve, reject) => {
            const store = this._store('readingNotes', 'readonly');
            const idx = store.index('sourceId');
            const req = idx.getAll(sourceId);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async getAllReadingNotes() {
        const store = this._store('readingNotes', 'readonly');
        return this._req(store, 'getAll');
    }

    async updateReadingNote(note) {
        const store = this._store('readingNotes', 'readwrite');
        return this._req(store, 'put', this._normalizeReadingNote(note));
    }

    async deleteReadingNote(id) {
        const store = this._store('readingNotes', 'readwrite');
        return this._req(store, 'delete', id);
    }

    async getSetting(key) {
        const store = this._store('settings', 'readonly');
        const entry = await this._req(store, 'get', key);
        return entry ? entry.value : null;
    }

    async setSetting(key, value) {
        const store = this._store('settings', 'readwrite');
        return this._req(store, 'put', {
            key,
            value,
            updatedAt: Date.now()
        });
    }

    async deleteSetting(key) {
        const store = this._store('settings', 'readwrite');
        return this._req(store, 'delete', key);
    }

    async getStats() {
        const sources = await this.getAllSources();
        const highlights = await this.getAllHighlights();
        const now = Date.now();
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const ts = todayStart.getTime();

        const due = highlights.filter(highlight => !highlight.nextReviewAt || highlight.nextReviewAt <= now);
        const addedToday = highlights.filter(highlight => highlight.createdAt >= ts);
        const reviewedToday = highlights.filter(highlight => highlight.lastReviewedAt >= ts);

        let streak = 0;
        if (reviewedToday.length > 0) streak = 1;
        const dayMs = 86400000;
        let checkDate = ts - dayMs;
        while (true) {
            const hasReview = highlights.some(highlight =>
                highlight.lastReviewedAt >= checkDate && highlight.lastReviewedAt < checkDate + dayMs
            );
            if (!hasReview) break;
            streak++;
            checkDate -= dayMs;
        }

        const mastery = [0, 0, 0, 0, 0, 0];
        for (const highlight of highlights) {
            mastery[highlight.masteryLevel || 0]++;
        }

        return {
            totalSources: sources.length,
            totalHighlights: highlights.length,
            dueCount: due.length,
            addedToday: addedToday.length,
            reviewedToday: reviewedToday.length,
            streak,
            mastery
        };
    }

    async exportAll() {
        const sources = await this.getAllSources();
        const highlights = await this.getAllHighlights();
        const readingNotes = await this.getAllReadingNotes();
        return {
            format: BACKUP_FORMAT,
            backupVersion: BACKUP_VERSION,
            version: DB_VERSION,
            schemaVersion: DB_VERSION,
            exportedAt: Date.now(),
            sources,
            highlights,
            readingNotes,
            counts: {
                sources: sources.length,
                highlights: highlights.length,
                readingNotes: readingNotes.length
            }
        };
    }

    async importAll(data, opts = {}) {
        const payload = this._normalizeBackupPayload(data);
        const mode = opts.mode === 'merge' ? 'merge' : 'replace';

        if (mode === 'merge') {
            const existingSources = await this.getAllSources();
            const existingHighlights = await this.getAllHighlights();
            const existingReadingNotes = await this.getAllReadingNotes();
            const sourceByKey = new Map(existingSources.map(source => [this._sourceFingerprint(source), source]));
            const sourceKeyById = new Map(existingSources.map(source => [source.id, this._sourceFingerprint(source)]));
            const sourceIdMap = new Map();
            const result = {
                mode,
                sources: { total: payload.sources.length, added: 0, updated: 0, skipped: 0 },
                highlights: { total: payload.highlights.length, added: 0, updated: 0, skipped: 0 },
                readingNotes: { total: payload.readingNotes.length, added: 0, updated: 0, skipped: 0 }
            };

            for (const source of payload.sources) {
                const normalized = this._normalizeSource(source);
                const key = this._sourceFingerprint(normalized);
                const existing = sourceByKey.get(key);

                if (existing) {
                    sourceIdMap.set(source.id, existing.id);
                    if ((normalized.updatedAt || 0) > (existing.updatedAt || 0)) {
                        const merged = this._mergeSourceRecord(existing, normalized);
                        await this._putRecord('sources', merged);
                        sourceByKey.set(key, merged);
                        sourceKeyById.set(existing.id, key);
                        result.sources.updated++;
                    } else {
                        result.sources.skipped++;
                    }
                    continue;
                }

                const newId = await this._addRecord('sources', normalized);
                const created = { ...normalized, id: newId };
                sourceIdMap.set(source.id, newId);
                sourceByKey.set(key, created);
                sourceKeyById.set(newId, key);
                result.sources.added++;
            }

            const highlightByKey = new Map(existingHighlights.map(highlight => [
                this._highlightFingerprint(highlight, this._sourceKeyForId(highlight.sourceId, sourceKeyById)),
                highlight
            ]));

            for (const highlight of payload.highlights) {
                const normalized = this._normalizeHighlight({
                    ...highlight,
                    sourceId: this._mapImportedSourceId(highlight.sourceId, sourceIdMap)
                });
                const key = this._highlightFingerprint(normalized, this._sourceKeyForId(normalized.sourceId, sourceKeyById));
                const existing = highlightByKey.get(key);

                if (existing) {
                    if ((normalized.updatedAt || 0) > (existing.updatedAt || 0) || (normalized.lastReviewedAt || 0) > (existing.lastReviewedAt || 0)) {
                        const merged = this._mergeHighlightRecord(existing, normalized);
                        await this._putRecord('highlights', merged);
                        highlightByKey.set(key, merged);
                        result.highlights.updated++;
                    } else {
                        result.highlights.skipped++;
                    }
                    continue;
                }

                const newId = await this._addRecord('highlights', normalized);
                highlightByKey.set(key, { ...normalized, id: newId });
                result.highlights.added++;
            }

            const noteByKey = new Map(existingReadingNotes.map(note => [
                this._readingNoteFingerprint(note, this._sourceKeyForId(note.sourceId, sourceKeyById)),
                note
            ]));

            for (const note of payload.readingNotes) {
                const normalized = this._normalizeReadingNote({
                    ...note,
                    sourceId: this._mapImportedSourceId(note.sourceId, sourceIdMap)
                });
                const key = this._readingNoteFingerprint(normalized, this._sourceKeyForId(normalized.sourceId, sourceKeyById));

                if (noteByKey.has(key)) {
                    result.readingNotes.skipped++;
                    continue;
                }

                const newId = await this._addRecord('readingNotes', normalized);
                noteByKey.set(key, { ...normalized, id: newId });
                result.readingNotes.added++;
            }

            return result;
        }

        await this._clearStore('sources');
        await this._clearStore('highlights');
        await this._clearStore('readingNotes');

        for (const source of payload.sources) {
            await this._putRecord('sources', this._normalizeSource(source));
        }

        for (const highlight of payload.highlights) {
            await this._putRecord('highlights', this._normalizeHighlight(highlight));
        }

        for (const note of payload.readingNotes) {
            await this._putRecord('readingNotes', this._normalizeReadingNote(note));
        }

        return {
            mode,
            sources: { total: payload.sources.length, added: payload.sources.length, updated: 0, skipped: 0 },
            highlights: { total: payload.highlights.length, added: payload.highlights.length, updated: 0, skipped: 0 },
            readingNotes: { total: payload.readingNotes.length, added: payload.readingNotes.length, updated: 0, skipped: 0 }
        };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        Database,
        DB_NAME,
        DB_VERSION,
        BACKUP_FORMAT,
        BACKUP_VERSION
    };
}
