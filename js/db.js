/**
 * LangLens - IndexedDB Data Layer
 * Stores imported sources and saved study items.
 */

const DB_NAME = 'LangLensDB';
const DB_VERSION = 3;

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
        return this._req(store, 'add', {
            ...note,
            createdAt: note.createdAt || Date.now()
        });
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
        return this._req(store, 'put', note);
    }

    async deleteReadingNote(id) {
        const store = this._store('readingNotes', 'readwrite');
        return this._req(store, 'delete', id);
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
            version: DB_VERSION,
            exportedAt: Date.now(),
            sources,
            highlights,
            readingNotes
        };
    }

    async importAll(data) {
        if (!data || !data.sources || !data.highlights) {
            throw new Error('Invalid import data format');
        }

        const clearStore = (name) => {
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(name, 'readwrite');
                const req = tx.objectStore(name).clear();
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            });
        };

        await clearStore('sources');
        await clearStore('highlights');
        await clearStore('readingNotes');

        for (const source of data.sources) {
            const store = this._store('sources', 'readwrite');
            await this._req(store, 'put', this._normalizeSource(source));
        }

        for (const highlight of data.highlights) {
            const store = this._store('highlights', 'readwrite');
            await this._req(store, 'put', this._normalizeHighlight(highlight));
        }

        if (data.readingNotes) {
            for (const note of data.readingNotes) {
                const store = this._store('readingNotes', 'readwrite');
                await this._req(store, 'put', note);
            }
        }

        return {
            sources: data.sources.length,
            highlights: data.highlights.length,
            readingNotes: (data.readingNotes || []).length
        };
    }
}
