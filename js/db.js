/**
 * LangLens - IndexedDB Data Layer
 * Stores: sources (imported texts), highlights (saved vocab/grammar/phrases)
 */

const DB_NAME = 'LangLensDB';
const DB_VERSION = 1;

class Database {
    constructor() {
        this.db = null;
    }

    init() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);

            req.onupgradeneeded = (e) => {
                const db = e.target.result;

                if (!db.objectStoreNames.contains('sources')) {
                    const s = db.createObjectStore('sources', { keyPath: 'id', autoIncrement: true });
                    s.createIndex('createdAt', 'createdAt');
                    s.createIndex('sourceType', 'sourceType');
                    s.createIndex('language', 'language');
                }

                if (!db.objectStoreNames.contains('highlights')) {
                    const h = db.createObjectStore('highlights', { keyPath: 'id', autoIncrement: true });
                    h.createIndex('sourceId', 'sourceId');
                    h.createIndex('createdAt', 'createdAt');
                    h.createIndex('nextReviewAt', 'nextReviewAt');
                    h.createIndex('type', 'type');
                    h.createIndex('masteryLevel', 'masteryLevel');
                }
            };

            req.onsuccess = (e) => {
                this.db = e.target.result;
                resolve();
            };

            req.onerror = (e) => reject(e.target.error);
        });
    }

    // === Generic helpers ===

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

    // === Sources ===

    async addSource(source) {
        const s = this._store('sources', 'readwrite');
        source.createdAt = source.createdAt || Date.now();
        source.updatedAt = Date.now();
        return this._req(s, 'add', source);
    }

    async getSource(id) {
        const s = this._store('sources', 'readonly');
        return this._req(s, 'get', id);
    }

    async getAllSources() {
        const s = this._store('sources', 'readonly');
        return this._req(s, 'getAll');
    }

    async updateSource(source) {
        source.updatedAt = Date.now();
        const s = this._store('sources', 'readwrite');
        return this._req(s, 'put', source);
    }

    async deleteSource(id) {
        const s = this._store('sources', 'readwrite');
        await this._req(s, 'delete', id);
        // Also delete associated highlights
        const highlights = await this.getHighlightsBySource(id);
        if (highlights.length > 0) {
            const hs = this._store('highlights', 'readwrite');
            for (const h of highlights) {
                hs.delete(h.id);
            }
        }
    }

    // === Highlights ===

    async addHighlight(highlight) {
        highlight.createdAt = highlight.createdAt || Date.now();
        highlight.masteryLevel = highlight.masteryLevel || 0;
        highlight.easeFactor = highlight.easeFactor || 2.5;
        highlight.interval = highlight.interval || 0;
        highlight.nextReviewAt = highlight.nextReviewAt || 0;
        highlight.lastReviewedAt = highlight.lastReviewedAt || 0;
        highlight.reviewCount = highlight.reviewCount || 0;
        const s = this._store('highlights', 'readwrite');
        return this._req(s, 'add', highlight);
    }

    async getHighlight(id) {
        const s = this._store('highlights', 'readonly');
        return this._req(s, 'get', id);
    }

    async getAllHighlights() {
        const s = this._store('highlights', 'readonly');
        return this._req(s, 'getAll');
    }

    async getHighlightsBySource(sourceId) {
        return new Promise((resolve, reject) => {
            const s = this._store('highlights', 'readonly');
            const idx = s.index('sourceId');
            const req = idx.getAll(sourceId);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async getDueHighlights() {
        const all = await this.getAllHighlights();
        const now = Date.now();
        return all.filter(h => !h.nextReviewAt || h.nextReviewAt <= now);
    }

    async updateHighlight(highlight) {
        const s = this._store('highlights', 'readwrite');
        return this._req(s, 'put', highlight);
    }

    async deleteHighlight(id) {
        const s = this._store('highlights', 'readwrite');
        return this._req(s, 'delete', id);
    }

    // === Stats ===

    async getStats() {
        const sources = await this.getAllSources();
        const highlights = await this.getAllHighlights();
        const now = Date.now();
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const ts = todayStart.getTime();

        const due = highlights.filter(h => !h.nextReviewAt || h.nextReviewAt <= now);
        const addedToday = highlights.filter(h => h.createdAt >= ts);
        const reviewedToday = highlights.filter(h => h.lastReviewedAt >= ts);

        // Calculate streak: consecutive days with reviews going backward
        let streak = 0;
        if (reviewedToday.length > 0) streak = 1;
        const dayMs = 86400000;
        let checkDate = ts - dayMs;
        while (true) {
            const hasReview = highlights.some(h =>
                h.lastReviewedAt >= checkDate && h.lastReviewedAt < checkDate + dayMs
            );
            if (!hasReview) break;
            streak++;
            checkDate -= dayMs;
        }

        // Mastery distribution
        const mastery = [0, 0, 0, 0, 0, 0]; // levels 0-5
        for (const h of highlights) {
            mastery[h.masteryLevel || 0]++;
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

    // === Export / Import ===

    async exportAll() {
        const sources = await this.getAllSources();
        const highlights = await this.getAllHighlights();
        return {
            version: DB_VERSION,
            exportedAt: Date.now(),
            sources,
            highlights
        };
    }

    async importAll(data) {
        if (!data || !data.sources || !data.highlights) {
            throw new Error('Invalid import data format');
        }

        // Clear existing data
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

        // Import sources
        for (const src of data.sources) {
            const s = this._store('sources', 'readwrite');
            await this._req(s, 'put', src);
        }

        // Import highlights
        for (const hl of data.highlights) {
            const s = this._store('highlights', 'readwrite');
            await this._req(s, 'put', hl);
        }

        return {
            sources: data.sources.length,
            highlights: data.highlights.length
        };
    }
}
