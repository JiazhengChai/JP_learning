/**
 * LangLens - Main Application Logic
 * Simplified study-item capture with lightweight flashcard review.
 */

class App {
    constructor() {
        this.db = new Database();
        this.currentView = 'dashboard';
        this.currentSource = null;
        this.reviewSession = null;
        this.reviewFilterCategory = '';
        this._pendingSelection = null;
        this._selectionHandler = null;
        this._toastTimer = null;
    }

    async init() {
        await this.db.init();
        this.loadTheme();
        this.bindEvents();
        this.navigate('dashboard');
        this.updateReviewBadge();
    }

    loadTheme() {
        const saved = localStorage.getItem('langlens-theme') || 'dark';
        document.documentElement.setAttribute('data-theme', saved);
        this.updateThemeButton(saved);
    }

    toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme') || 'dark';
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('langlens-theme', next);
        this.updateThemeButton(next);
    }

    updateThemeButton(theme) {
        const btn = document.getElementById('btn-theme');
        if (btn) {
            btn.textContent = theme === 'dark' ? '☀️ Light' : '🌙 Dark';
            btn.title = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`;
        }
    }

    esc(str) {
        const d = document.createElement('div');
        d.textContent = str == null ? '' : String(str);
        return d.innerHTML;
    }

    formatDate(ts) {
        if (!ts) return '—';
        return new Date(ts).toLocaleDateString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric'
        });
    }

    formatDateTime(ts) {
        if (!ts) return '—';
        return new Date(ts).toLocaleString(undefined, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    }

    relativeTime(ts) {
        if (!ts) return '';
        const diff = ts - Date.now();
        const absDiff = Math.abs(diff);
        const mins = Math.floor(absDiff / 60000);
        const hours = Math.floor(absDiff / 3600000);
        const days = Math.floor(absDiff / 86400000);

        if (diff < 0) {
            if (mins < 60) return `${mins}m ago`;
            if (hours < 24) return `${hours}h ago`;
            return `${days}d ago`;
        }

        if (mins < 60) return `in ${mins}m`;
        if (hours < 24) return `in ${hours}h`;
        return `in ${days}d`;
    }

    formatInterval(days) {
        if (days < 1) return '< 1d';
        if (days === 1) return '1 day';
        if (days < 30) return `${Math.round(days)} days`;
        if (days < 365) return `${Math.round(days / 30)} months`;
        return `${(days / 365).toFixed(1)} years`;
    }

    masteryName(level) {
        return ['New', 'Learning', 'Familiar', 'Known', 'Strong', 'Mastered'][level] || 'New';
    }

    showToast(msg, type = '') {
        const toast = document.getElementById('toast');
        toast.textContent = msg;
        toast.className = `toast ${type ? 'toast-' + type : ''}`;
        toast.classList.remove('hidden');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => toast.classList.add('hidden'), 2500);
    }

    extractContext(content, start, end, maxLen = 120) {
        const enders = /[.!?。！？\n\r]/;
        let cs = start;
        for (let i = start - 1; i >= Math.max(0, start - maxLen); i--) {
            if (enders.test(content[i])) {
                cs = i + 1;
                break;
            }
            cs = i;
        }
        let ce = end;
        for (let i = end; i < Math.min(content.length, end + maxLen); i++) {
            ce = i + 1;
            if (enders.test(content[i])) break;
        }
        return content.substring(cs, ce).trim();
    }

    getUniqueCategories(items) {
        return [...new Set(items.map(item => (item.category || 'General').trim()).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b));
    }

    getSourceLabel(item, sourceMap = {}) {
        if (!item.sourceId) return 'Manual';
        const source = sourceMap[item.sourceId];
        return source ? source.title : 'Source';
    }

    bindEvents() {
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                this.navigate(link.dataset.view);
            });
        });

        document.getElementById('selection-save-item')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._pendingSelection) {
                this.showQuickAddItemModal(this._pendingSelection, { title: 'Save Study Item' });
            }
            this.hideSelectionToolbar();
        });

        document.getElementById('selection-add-note')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._pendingSelection) {
                this.showAddReadingNoteModal(this._pendingSelection);
            }
            this.hideSelectionToolbar();
        });

        document.getElementById('modal-overlay').addEventListener('click', (e) => {
            if (e.target.id === 'modal-overlay') this.closeModal();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeModal();
                this.hideSelectionToolbar();
            }

            if (this.currentView === 'review' && this.reviewSession && !this.reviewSession.revealed && e.key === ' ') {
                e.preventDefault();
                this.flipCard();
            }

            if (this.currentView === 'review' && this.reviewSession && this.reviewSession.revealed && e.key === ' ') {
                e.preventDefault();
                this.rateCard(3);
            }

            if (this.currentView === 'review' && this.reviewSession && this.reviewSession.revealed) {
                if (e.key === '1') this.rateCard(1);
                else if (e.key === '2') this.rateCard(2);
                else if (e.key === '3') this.rateCard(3);
                else if (e.key === '4') this.rateCard(4);
            }
        });

        document.addEventListener('mousedown', (e) => {
            const toolbar = document.getElementById('selection-toolbar');
            if (!toolbar.contains(e.target)) {
                this.hideSelectionToolbar();
            }
        });

        document.getElementById('btn-theme')?.addEventListener('click', () => this.toggleTheme());
        document.getElementById('btn-export').addEventListener('click', () => this.exportData());
        document.getElementById('btn-import').addEventListener('click', () => {
            document.getElementById('import-file').click();
        });
        document.getElementById('import-file').addEventListener('change', (e) => {
            if (e.target.files[0]) this.importData(e.target.files[0]);
            e.target.value = '';
        });
    }

    hideSelectionToolbar() {
        document.getElementById('selection-toolbar').classList.add('hidden');
        this._pendingSelection = null;
    }

    navigate(viewName) {
        this.currentView = viewName;

        document.querySelectorAll('.nav-link').forEach(link => link.classList.remove('active'));
        const active = document.querySelector(`.nav-link[data-view="${viewName}"]`);
        if (active) active.classList.add('active');

        document.querySelectorAll('.view').forEach(view => {
            view.classList.remove('active');
            view.classList.add('hidden');
        });
        const view = document.getElementById(`view-${viewName}`);
        if (view) {
            view.classList.remove('hidden');
            view.classList.add('active');
        }

        if (viewName !== 'reader' && this._selectionHandler) {
            document.removeEventListener('mouseup', this._selectionHandler);
            this._selectionHandler = null;
        }

        if (viewName === 'dashboard') this.renderDashboard();
        if (viewName === 'library') this.renderLibrary();
        if (viewName === 'vocab') this.renderVocab();
        if (viewName === 'review') this.renderReviewSetup();

        document.getElementById('main').scrollTop = 0;
    }

    showModal(html, opts = {}) {
        const overlay = document.getElementById('modal-overlay');
        const content = document.getElementById('modal-content');
        content.innerHTML = html;
        content.className = `modal-content ${opts.size || ''}`;
        overlay.classList.remove('hidden');
    }

    closeModal() {
        document.getElementById('modal-overlay').classList.add('hidden');
    }

    async updateReviewBadge() {
        const due = await this.db.getDueHighlights();
        const badge = document.getElementById('review-badge');
        if (due.length > 0) {
            badge.textContent = due.length;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }

    async renderDashboard() {
        const stats = await this.db.getStats();
        const items = await this.db.getAllHighlights();
        const recent = [...items].sort((a, b) => b.createdAt - a.createdAt).slice(0, 8);

        const view = document.getElementById('view-dashboard');
        view.innerHTML = `
            <div class="view-header">
                <h2>Dashboard</h2>
            </div>

            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-icon">🧠</div>
                    <div class="stat-value">${stats.dueCount}</div>
                    <div class="stat-label">Due for Review</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">🗂️</div>
                    <div class="stat-value">${this.getUniqueCategories(items).length}</div>
                    <div class="stat-label">Categories</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">🔤</div>
                    <div class="stat-value">${stats.totalHighlights}</div>
                    <div class="stat-label">Study Items</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">📚</div>
                    <div class="stat-value">${stats.totalSources}</div>
                    <div class="stat-label">Texts</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">📝</div>
                    <div class="stat-value">${stats.addedToday}</div>
                    <div class="stat-label">Added Today</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">✅</div>
                    <div class="stat-value">${stats.reviewedToday}</div>
                    <div class="stat-label">Reviewed Today</div>
                </div>
            </div>

            <div class="quick-actions">
                <button class="btn btn-primary btn-lg" id="dash-add-item">➕ Add Item</button>
                <button class="btn btn-secondary btn-lg" id="dash-review" ${stats.dueCount === 0 ? 'disabled' : ''}>🧠 Review ${stats.dueCount > 0 ? `(${stats.dueCount})` : ''}</button>
                <button class="btn btn-secondary btn-lg" id="dash-add-source">📚 Add Text</button>
            </div>

            ${recent.length > 0 ? `
                <div class="section-title">Recently Added</div>
                <div class="recent-list">
                    ${recent.map(item => `
                        <div class="recent-item" data-hl-id="${item.id}">
                            <span class="hl-type-dot dot-item"></span>
                            <span class="ri-text">${this.esc(item.text)}</span>
                            <span class="ri-chip">${this.esc(item.category || 'General')}</span>
                            <span class="ri-meta">${item.charCount || item.text.length} chars</span>
                        </div>
                    `).join('')}
                </div>
            ` : `
                <div class="empty-state">
                    <div class="empty-icon">📝</div>
                    <p>No study items yet. Add your first text-note pair and start reviewing.</p>
                </div>
            `}
        `;

        document.getElementById('dash-add-item')?.addEventListener('click', () => {
            this.showQuickAddItemModal({}, { title: 'Add New Item' });
        });
        document.getElementById('dash-add-source')?.addEventListener('click', () => this.showAddSourceModal());
        document.getElementById('dash-review')?.addEventListener('click', () => {
            this.navigate('review');
            setTimeout(() => this.startReviewSession(), 100);
        });
        view.querySelectorAll('.recent-item').forEach(item => {
            item.addEventListener('click', () => this.showHighlightDetailModal(parseInt(item.dataset.hlId, 10)));
        });
    }

    async renderLibrary() {
        const sources = await this.db.getAllSources();
        const highlights = await this.db.getAllHighlights();
        const counts = {};
        for (const item of highlights) {
            if (item.sourceId) counts[item.sourceId] = (counts[item.sourceId] || 0) + 1;
        }

        const view = document.getElementById('view-library');
        const sorted = [...sources].sort((a, b) => b.createdAt - a.createdAt);

        view.innerHTML = `
            <div class="view-header">
                <h2>📚 Library</h2>
                <div class="view-header-actions">
                    <button class="btn btn-primary" id="lib-add">➕ Add Text</button>
                </div>
            </div>

            ${sorted.length === 0 ? `
                <div class="empty-state">
                    <div class="empty-icon">📚</div>
                    <p>Your text library is empty. Add a source if you want to pull study items directly from reading.</p>
                    <button class="btn btn-primary" id="lib-add-empty">➕ Add Your First Text</button>
                </div>
            ` : `
                <div class="cards-grid">
                    ${sorted.map(source => `
                        <div class="source-card" data-id="${source.id}">
                            <div class="card-header">
                                <div class="card-title">${this.esc(source.title)}</div>
                                <span class="type-badge ${source.sourceType}">${source.sourceType}</span>
                            </div>
                            <div class="card-preview">${this.esc(source.content.substring(0, 200))}</div>
                            <div class="card-meta">
                                <span>📝 ${counts[source.id] || 0} items</span>
                                <span>${this.formatDate(source.createdAt)}</span>
                                ${source.language ? `<span>🌐 ${this.esc(source.language)}</span>` : ''}
                            </div>
                            ${source.tags && source.tags.length > 0 ? `
                                <div class="card-tags">
                                    ${source.tags.map(tag => `<span class="tag">${this.esc(tag)}</span>`).join('')}
                                </div>
                            ` : ''}
                        </div>
                    `).join('')}
                </div>
            `}
        `;

        document.getElementById('lib-add')?.addEventListener('click', () => this.showAddSourceModal());
        document.getElementById('lib-add-empty')?.addEventListener('click', () => this.showAddSourceModal());
        view.querySelectorAll('.source-card').forEach(card => {
            card.addEventListener('click', () => this.openReader(parseInt(card.dataset.id, 10)));
        });
    }

    showAddSourceModal() {
        this.showModal(`
            <h3>📝 Add New Text</h3>
            <form id="add-source-form">
                <div class="form-group">
                    <label>Title</label>
                    <input type="text" id="src-title" placeholder="e.g., NHK News Article, Podcast Ep. 42..." required>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Source Type</label>
                        <select id="src-type">
                            <option value="article">📄 Article</option>
                            <option value="audio">🎧 Audio Transcript</option>
                            <option value="video">🎬 Video Subtitle</option>
                            <option value="other">📋 Other</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Language</label>
                        <input type="text" id="src-lang" placeholder="e.g., Japanese" value="Japanese">
                    </div>
                </div>
                <div class="form-group">
                    <label>Tags <span class="form-hint">(comma-separated)</span></label>
                    <input type="text" id="src-tags" placeholder="e.g., N3, news, conversation">
                </div>
                <div class="form-group">
                    <label>Upload File <span class="form-hint">(.txt, .pdf, .html, .htm, .md)</span></label>
                    <input type="file" id="src-file-upload" accept=".txt,.pdf,.html,.htm,.md,.csv,.xml,.json,.srt,.vtt,.epub">
                    <div id="src-file-status" style="font-size:0.78rem;color:var(--text-muted);margin-top:6px;"></div>
                </div>
                <div class="form-group">
                    <label>Content</label>
                    <textarea id="src-content" rows="10" placeholder="Paste your text content here or upload a file above..." required></textarea>
                </div>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" id="src-cancel">Cancel</button>
                    <button type="submit" class="btn btn-primary">💾 Save</button>
                </div>
            </form>
        `, { size: 'modal-lg' });

        document.getElementById('src-file-upload').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const status = document.getElementById('src-file-status');
            status.textContent = 'Extracting text...';
            status.style.color = 'var(--accent)';
            try {
                const text = await this.extractTextFromFile(file);
                document.getElementById('src-content').value = text;
                if (!document.getElementById('src-title').value.trim()) {
                    document.getElementById('src-title').value = file.name.replace(/\.[^.]+$/, '');
                }
                status.textContent = `✅ Extracted ${text.length} characters from ${file.name}`;
                status.style.color = 'var(--success)';
            } catch (err) {
                status.textContent = `❌ Failed: ${err.message}`;
                status.style.color = 'var(--danger)';
            }
        });

        document.getElementById('src-cancel').addEventListener('click', () => this.closeModal());
        document.getElementById('add-source-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const title = document.getElementById('src-title').value.trim();
            const content = document.getElementById('src-content').value;
            if (!title || !content) return;

            const tags = document.getElementById('src-tags').value
                .split(',')
                .map(tag => tag.trim())
                .filter(Boolean);

            await this.db.addSource({
                title,
                content,
                sourceType: document.getElementById('src-type').value,
                language: document.getElementById('src-lang').value.trim(),
                tags
            });

            this.closeModal();
            this.showToast('Text added to library!', 'success');
            if (this.currentView === 'library') this.renderLibrary();
            if (this.currentView === 'dashboard') this.renderDashboard();
        });
    }

    async extractTextFromFile(file) {
        const name = file.name.toLowerCase();
        const ext = name.substring(name.lastIndexOf('.'));

        if (ext === '.txt' || ext === '.md' || ext === '.csv' || ext === '.srt' || ext === '.vtt') {
            return await file.text();
        }

        if (ext === '.html' || ext === '.htm' || ext === '.xml') {
            const raw = await file.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(raw, ext === '.xml' ? 'text/xml' : 'text/html');
            // Remove script and style elements
            doc.querySelectorAll('script, style, noscript').forEach(el => el.remove());
            return (doc.body || doc.documentElement).textContent.replace(/\n{3,}/g, '\n\n').trim();
        }

        if (ext === '.json') {
            const raw = await file.text();
            try {
                const data = JSON.parse(raw);
                return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
            } catch {
                return raw;
            }
        }

        if (ext === '.pdf') {
            if (typeof pdfjsLib === 'undefined') {
                throw new Error('PDF.js library not loaded. Please refresh and try again.');
            }
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            const pages = [];
            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                const pageText = textContent.items.map(item => item.str).join(' ');
                if (pageText.trim()) pages.push(pageText.trim());
            }
            if (pages.length === 0) throw new Error('No text content found in PDF');
            return pages.join('\n\n');
        }

        throw new Error(`Unsupported file type: ${ext}`);
    }

    async openReader(sourceId) {
        const source = await this.db.getSource(sourceId);
        if (!source) {
            this.showToast('Source not found', 'error');
            return;
        }

        this.currentSource = source;
        this.currentView = 'reader';

        document.querySelectorAll('.nav-link').forEach(link => link.classList.remove('active'));
        document.querySelector('.nav-link[data-view="library"]')?.classList.add('active');
        document.querySelectorAll('.view').forEach(view => {
            view.classList.remove('active');
            view.classList.add('hidden');
        });
        const view = document.getElementById('view-reader');
        view.classList.remove('hidden');
        view.classList.add('active');

        await this.renderReader();
    }

    async renderReader() {
        if (!this.currentSource) return;

        const source = this.currentSource;
        const items = await this.db.getHighlightsBySource(source.id);
        const readingNotes = await this.db.getReadingNotesBySource(source.id);
        const view = document.getElementById('view-reader');

        view.innerHTML = `
            <button class="reader-back" id="reader-back">← Back to Library</button>
            <div class="reader-source-info">
                <h2>${this.esc(source.title)}</h2>
                <div class="meta">
                    <span class="type-badge ${source.sourceType}">${source.sourceType}</span>
                    ${source.language ? `<span>🌐 ${this.esc(source.language)}</span>` : ''}
                    <span>${this.formatDate(source.createdAt)}</span>
                    <span>📝 ${items.length} items</span>
                    <span>📌 ${readingNotes.length} notes</span>
                    <button class="btn btn-sm btn-secondary" id="reader-edit-source" title="Edit source">✏️</button>
                    <button class="btn btn-sm btn-secondary" id="reader-delete-source" title="Delete source" style="color:var(--danger)">🗑️</button>
                </div>
            </div>
            <div class="reader-layout">
                <div class="reader-text-area">
                    <div id="reader-content">${this.renderTextContent(source.content, items, readingNotes)}</div>
                </div>
                <div class="reader-sidebar">
                    <h3>Saved Items (${items.length})</h3>
                    <div id="reader-hl-list">
                        ${items.length === 0 ? '<p style="color:var(--text-muted);font-size:0.82rem;">Select text, then save it as a study item.</p>' : ''}
                        ${items.sort((a, b) => (a.startOffset || 0) - (b.startOffset || 0)).map(item => `
                            <div class="hl-list-item" data-hl-id="${item.id}">
                                <div class="hl-text">
                                    <span class="hl-type-dot dot-item"></span>
                                    ${this.esc(item.text)}
                                </div>
                                <div class="hl-meta-line">${this.esc(item.category || 'General')} · ${item.charCount || item.text.length} chars</div>
                                ${item.note ? `<div class="hl-note">${this.esc(item.note)}</div>` : ''}
                            </div>
                        `).join('')}
                    </div>
                    ${readingNotes.length > 0 ? `
                        <h3 style="margin-top:20px;">📌 Reading Notes (${readingNotes.length})</h3>
                        <div id="reader-notes-list">
                            ${readingNotes.sort((a, b) => (a.startOffset || 0) - (b.startOffset || 0)).map(note => `
                                <div class="hl-list-item reading-note-item" data-note-id="${note.id}">
                                    <div class="hl-text" style="color:var(--${note.color === 'blue' ? 'accent' : note.color === 'green' ? 'success' : note.color === 'red' ? 'danger' : 'warning'});">
                                        📌 ${this.esc(note.text.substring(0, 40))}${note.text.length > 40 ? '…' : ''}
                                    </div>
                                    <div class="hl-note">${this.esc(note.note)}</div>
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;

        document.getElementById('reader-back').addEventListener('click', () => this.navigate('library'));
        document.getElementById('reader-delete-source')?.addEventListener('click', async () => {
            if (confirm(`Delete "${source.title}" and all its saved items?`)) {
                await this.db.deleteSource(source.id);
                this.currentSource = null;
                this.showToast('Source deleted', 'success');
                this.navigate('library');
                this.updateReviewBadge();
            }
        });
        document.getElementById('reader-edit-source')?.addEventListener('click', () => this.showEditSourceModal(source));

        view.querySelectorAll('.hl-list-item').forEach(item => {
            item.addEventListener('click', () => this.showHighlightDetailModal(parseInt(item.dataset.hlId, 10)));
        });
        view.querySelectorAll('.hl[data-hl-id]').forEach(span => {
            span.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showHighlightDetailModal(parseInt(span.dataset.hlId, 10));
            });
        });
        view.querySelectorAll('.reading-note-item').forEach(item => {
            item.addEventListener('click', () => this.showReadingNoteDetail(parseInt(item.dataset.noteId, 10)));
        });
        view.querySelectorAll('.hl-reading-note[data-note-id]').forEach(span => {
            span.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showReadingNoteDetail(parseInt(span.dataset.noteId, 10));
            });
        });

        if (this._selectionHandler) {
            document.removeEventListener('mouseup', this._selectionHandler);
        }
        this._selectionHandler = (e) => this.handleTextSelection(e);
        document.addEventListener('mouseup', this._selectionHandler);
        document.getElementById('main').scrollTop = 0;
    }

    renderTextContent(content, highlights, readingNotes = []) {
        // Combine highlights and reading notes into annotation segments
        const segments = [];

        for (const item of highlights) {
            if (typeof item.startOffset !== 'number' || typeof item.endOffset !== 'number') continue;
            segments.push({ type: 'highlight', start: item.startOffset, end: item.endOffset, data: item });
        }

        for (const note of readingNotes) {
            if (typeof note.startOffset !== 'number' || typeof note.endOffset !== 'number') continue;
            segments.push({ type: 'note', start: note.startOffset, end: note.endOffset, data: note });
        }

        segments.sort((a, b) => a.start - b.start || a.end - b.end);

        // Remove overlaps (highlights take priority, then notes)
        const clean = [];
        let lastEnd = 0;
        for (const seg of segments) {
            if (seg.start >= lastEnd) {
                clean.push(seg);
                lastEnd = seg.end;
            }
        }

        let html = '';
        let pos = 0;

        for (const seg of clean) {
            if (seg.start > pos) {
                html += `<span class="seg" data-offset="${pos}">${this.esc(content.substring(pos, seg.start))}</span>`;
            }
            if (seg.type === 'highlight') {
                const item = seg.data;
                const tooltip = this.esc(`${item.category || 'General'}${item.note ? ' — ' + item.note : ''}`);
                html += `<span class="seg hl hl-item" data-offset="${seg.start}" data-hl-id="${item.id}" title="${tooltip}">${this.esc(content.substring(seg.start, seg.end))}</span>`;
            } else {
                const note = seg.data;
                const colorClass = `rn-${note.color || 'yellow'}`;
                html += `<span class="seg hl hl-reading-note ${colorClass}" data-offset="${seg.start}" data-note-id="${note.id}" title="📌 ${this.esc(note.note)}">${this.esc(content.substring(seg.start, seg.end))}</span>`;
            }
            pos = seg.end;
        }

        if (pos < content.length) {
            html += `<span class="seg" data-offset="${pos}">${this.esc(content.substring(pos))}</span>`;
        }

        return html;
    }

    getSourceOffset(node, charOffset) {
        let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;

        while (el && el.getAttribute && el.getAttribute('data-offset') === null) {
            el = el.parentElement;
        }
        if (!el || !el.getAttribute || el.getAttribute('data-offset') === null) return -1;

        const baseOffset = parseInt(el.getAttribute('data-offset'), 10);

        if (node.nodeType === Node.TEXT_NODE) {
            let pos = 0;
            for (const child of el.childNodes) {
                if (child === node) {
                    pos += charOffset;
                    break;
                }
                pos += child.textContent.length;
            }
            return baseOffset + pos;
        }

        let pos = 0;
        for (let i = 0; i < charOffset && i < el.childNodes.length; i++) {
            pos += el.childNodes[i].textContent.length;
        }
        return baseOffset + pos;
    }

    handleTextSelection(e) {
        if (this.currentView !== 'reader' || !this.currentSource) return;

        const selection = window.getSelection();
        const text = selection.toString().trim();
        if (!text) return;

        const readerContent = document.getElementById('reader-content');
        if (!readerContent) return;

        const range = selection.getRangeAt(0);
        if (!readerContent.contains(range.commonAncestorContainer)) return;

        const clickedHighlight = e.target.closest && e.target.closest('.hl[data-hl-id]');
        if (clickedHighlight && text === clickedHighlight.textContent.trim()) return;

        const startOffset = this.getSourceOffset(range.startContainer, range.startOffset);
        const endOffset = this.getSourceOffset(range.endContainer, range.endOffset);
        if (startOffset === -1 || endOffset === -1 || startOffset >= endOffset) return;

        this._pendingSelection = {
            text,
            note: '',
            sourceId: this.currentSource.id,
            startOffset,
            endOffset,
            context: this.extractContext(this.currentSource.content, startOffset, endOffset)
        };

        const rect = range.getBoundingClientRect();
        const toolbar = document.getElementById('selection-toolbar');
        toolbar.style.top = `${rect.top - 48}px`;
        toolbar.style.left = `${rect.left + rect.width / 2}px`;
        toolbar.classList.remove('hidden');
    }

    async buildCategoryMarkup(selectedCategory = 'vocab') {
        const items = await this.db.getAllHighlights();
        const categories = this.getUniqueCategories(items);
        if (!categories.includes('vocab')) categories.unshift('vocab');
        if (!categories.includes('phrase')) categories.splice(categories.indexOf('vocab') + 1, 0, 'phrase');

        return categories.map(category => `
            <button type="button" class="category-chip ${category === selectedCategory ? 'active' : ''}" data-category="${this.esc(category)}">${this.esc(category)}</button>
        `).join('');
    }

    suggestCategory(text) {
        if (!text) return 'vocab';
        const len = text.trim().length;
        if (len > 8) return 'phrase';
        return 'vocab';
    }

    async showQuickAddItemModal(data = {}, opts = {}) {
        const suggestedCat = data.category || this.reviewFilterCategory || this.suggestCategory(data.text || '');
        const categoryMarkup = await this.buildCategoryMarkup(suggestedCat);
        const title = opts.title || 'Add New Item';
        const sourceLabel = data.sourceId && this.currentSource ? this.currentSource.title : '';
        const showContext = sourceLabel || data.context;

        this.showModal(`
            <h3>${this.esc(title)}</h3>
            <form id="item-form">
                <div class="form-group">
                    <label>Input Text</label>
                    <input type="text" id="item-text" value="${this.esc(data.text || '')}" placeholder="e.g., 気になる" required>
                </div>
                <div class="form-group">
                    <label>Note</label>
                    <textarea id="item-note" rows="4" placeholder="Meaning, reminder, nuance, example...">${this.esc(data.note || '')}</textarea>
                </div>
                <div class="form-group">
                    <label>Category <span class="form-hint">optional quick grouping</span></label>
                    <div class="category-chip-row">${categoryMarkup}</div>
                    <div class="inline-input-row">
                        <input type="text" id="item-new-category" placeholder="New category name">
                    </div>
                </div>
                ${showContext ? `
                    <div class="item-meta-panel">
                        ${sourceLabel ? `<div><strong>Source:</strong> ${this.esc(sourceLabel)}</div>` : ''}
                        ${data.context ? `<div><strong>Context:</strong> ${this.esc(data.context)}</div>` : ''}
                    </div>
                ` : ''}
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" id="item-cancel">Cancel</button>
                    <button type="submit" class="btn btn-primary">💾 Save</button>
                </div>
            </form>
        `);

        const chips = [...document.querySelectorAll('.category-chip')];
        chips.forEach(chip => {
            chip.addEventListener('click', () => {
                chips.forEach(node => node.classList.remove('active'));
                chip.classList.add('active');
                document.getElementById('item-new-category').value = '';
            });
        });

        document.getElementById('item-cancel').addEventListener('click', () => this.closeModal());
        document.getElementById('item-text')?.addEventListener('input', (e) => {
            const suggested = this.suggestCategory(e.target.value);
            const customVal = document.getElementById('item-new-category').value.trim();
            if (!customVal) {
                const chips = [...document.querySelectorAll('.category-chip')];
                const alreadyActive = chips.find(c => c.classList.contains('active'));
                // Only auto-suggest if user hasn't manually picked something different
                if (!alreadyActive || alreadyActive.dataset.category === 'vocab' || alreadyActive.dataset.category === 'phrase') {
                    chips.forEach(c => c.classList.remove('active'));
                    const match = chips.find(c => c.dataset.category === suggested);
                    if (match) match.classList.add('active');
                }
            }
        });
        document.getElementById('item-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const text = document.getElementById('item-text').value.trim();
            const note = document.getElementById('item-note').value.trim();
            if (!text) return;

            const activeCategory = document.querySelector('.category-chip.active')?.dataset.category || 'vocab';
            const customCategory = document.getElementById('item-new-category').value.trim();
            const category = customCategory || activeCategory || 'vocab';

            await this.db.addHighlight({
                sourceId: data.sourceId || null,
                text,
                note,
                category,
                context: data.context || '',
                startOffset: data.startOffset,
                endOffset: data.endOffset
            });

            this.closeModal();
            this.showToast('Item saved!', 'success');
            window.getSelection().removeAllRanges();
            if (this.currentView === 'reader' && this.currentSource) await this.renderReader();
            if (this.currentView === 'vocab') await this.renderVocab();
            if (this.currentView === 'dashboard') await this.renderDashboard();
            this.updateReviewBadge();
        });
    }

    async showHighlightDetailModal(hlId) {
        const item = await this.db.getHighlight(hlId);
        if (!item) return;
        const source = item.sourceId ? await this.db.getSource(item.sourceId) : null;

        this.showModal(`
            <h3>📝 Study Item</h3>
            <div class="selected-text-preview">${this.esc(item.text)}</div>
            <div class="detail-stack">
                <div><strong>Note:</strong> ${this.esc(item.note || '—')}</div>
                <div><strong>Category:</strong> ${this.esc(item.category || 'General')}</div>
                <div><strong>Added:</strong> ${this.formatDateTime(item.createdAt)}</div>
                <div><strong>Characters:</strong> ${item.charCount || item.text.length}</div>
                <div><strong>Reviews:</strong> ${item.reviewCount || 0} · ${this.masteryName(item.masteryLevel || 0)}</div>
                ${item.nextReviewAt ? `<div><strong>Next review:</strong> ${this.relativeTime(item.nextReviewAt)}</div>` : ''}
                ${source ? `<div><strong>Source:</strong> ${this.esc(source.title)}</div>` : '<div><strong>Source:</strong> Manual</div>'}
                ${item.context ? `<div><strong>Context:</strong> <span class="detail-context">${this.esc(item.context)}</span></div>` : ''}
            </div>
            <div class="form-actions">
                <button class="btn btn-danger btn-sm" id="hl-delete">🗑️ Delete</button>
                <button class="btn btn-secondary" id="hl-edit">✏️ Edit</button>
                <button class="btn btn-primary" id="hl-close">Close</button>
            </div>
        `);

        document.getElementById('hl-close').addEventListener('click', () => this.closeModal());
        document.getElementById('hl-delete').addEventListener('click', async () => {
            if (!confirm('Delete this item?')) return;
            await this.db.deleteHighlight(hlId);
            this.closeModal();
            this.showToast('Item deleted', 'success');
            if (this.currentView === 'reader') await this.renderReader();
            if (this.currentView === 'vocab') await this.renderVocab();
            if (this.currentView === 'dashboard') await this.renderDashboard();
            this.updateReviewBadge();
        });
        document.getElementById('hl-edit').addEventListener('click', () => {
            this.closeModal();
            this.showEditHighlightModal(item);
        });
    }

    async showEditHighlightModal(item) {
        const categoryMarkup = await this.buildCategoryMarkup(item.category || 'vocab');

        this.showModal(`
            <h3>✏️ Edit Item</h3>
            <form id="edit-hl-form">
                <div class="form-group">
                    <label>Input Text</label>
                    <input type="text" id="hl-text" value="${this.esc(item.text || '')}" required>
                </div>
                <div class="form-group">
                    <label>Note</label>
                    <textarea id="hl-note" rows="4">${this.esc(item.note || '')}</textarea>
                </div>
                <div class="form-group">
                    <label>Category</label>
                    <div class="category-chip-row">${categoryMarkup}</div>
                    <div class="inline-input-row">
                        <input type="text" id="hl-new-category" placeholder="New category name">
                    </div>
                </div>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" id="hl-cancel">Cancel</button>
                    <button type="submit" class="btn btn-primary">💾 Update</button>
                </div>
            </form>
        `);

        const chips = [...document.querySelectorAll('.category-chip')];
        chips.forEach(chip => {
            chip.addEventListener('click', () => {
                chips.forEach(node => node.classList.remove('active'));
                chip.classList.add('active');
                document.getElementById('hl-new-category').value = '';
            });
        });

        document.getElementById('hl-cancel').addEventListener('click', () => this.closeModal());
        document.getElementById('edit-hl-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            item.text = document.getElementById('hl-text').value.trim();
            item.note = document.getElementById('hl-note').value.trim();
            item.category = document.getElementById('hl-new-category').value.trim()
                || document.querySelector('.category-chip.active')?.dataset.category
                || 'vocab';

            await this.db.updateHighlight(item);
            this.closeModal();
            this.showToast('Item updated!', 'success');
            if (this.currentView === 'reader') await this.renderReader();
            if (this.currentView === 'vocab') await this.renderVocab();
            if (this.currentView === 'dashboard') await this.renderDashboard();
            this.updateReviewBadge();
        });
    }

    showEditSourceModal(source) {
        this.showModal(`
            <h3>✏️ Edit Source</h3>
            <form id="edit-source-form">
                <div class="form-group">
                    <label>Title</label>
                    <input type="text" id="src-title" value="${this.esc(source.title)}" required>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Source Type</label>
                        <select id="src-type">
                            <option value="article" ${source.sourceType === 'article' ? 'selected' : ''}>📄 Article</option>
                            <option value="audio" ${source.sourceType === 'audio' ? 'selected' : ''}>🎧 Audio</option>
                            <option value="video" ${source.sourceType === 'video' ? 'selected' : ''}>🎬 Video</option>
                            <option value="other" ${source.sourceType === 'other' ? 'selected' : ''}>📋 Other</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Language</label>
                        <input type="text" id="src-lang" value="${this.esc(source.language || '')}">
                    </div>
                </div>
                <div class="form-group">
                    <label>Tags</label>
                    <input type="text" id="src-tags" value="${this.esc((source.tags || []).join(', '))}">
                </div>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" id="src-cancel">Cancel</button>
                    <button type="submit" class="btn btn-primary">💾 Update</button>
                </div>
            </form>
        `);

        document.getElementById('src-cancel').addEventListener('click', () => this.closeModal());
        document.getElementById('edit-source-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            source.title = document.getElementById('src-title').value.trim();
            source.sourceType = document.getElementById('src-type').value;
            source.language = document.getElementById('src-lang').value.trim();
            source.tags = document.getElementById('src-tags').value.split(',').map(tag => tag.trim()).filter(Boolean);
            await this.db.updateSource(source);
            this.closeModal();
            this.showToast('Source updated!', 'success');
            this.currentSource = source;
            await this.renderReader();
        });
    }

    showAddReadingNoteModal(data) {
        if (!this.currentSource) return;
        this.showModal(`
            <h3>📌 Add Reading Note</h3>
            <div class="selected-text-preview">${this.esc(data.text)}</div>
            <form id="reading-note-form">
                <div class="form-group">
                    <label>Your Note</label>
                    <textarea id="rn-content" rows="4" placeholder="Write your thought, question, or observation..." required></textarea>
                </div>
                <div class="form-group">
                    <label>Color</label>
                    <div class="category-chip-row">
                        <button type="button" class="category-chip active" data-color="yellow" style="border-color:#d29922;color:#d29922;">🟡 Yellow</button>
                        <button type="button" class="category-chip" data-color="blue" style="border-color:#58a6ff;color:#58a6ff;">🔵 Blue</button>
                        <button type="button" class="category-chip" data-color="green" style="border-color:#3fb950;color:#3fb950;">🟢 Green</button>
                        <button type="button" class="category-chip" data-color="red" style="border-color:#f85149;color:#f85149;">🔴 Red</button>
                    </div>
                </div>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" id="rn-cancel">Cancel</button>
                    <button type="submit" class="btn btn-primary">📌 Save Note</button>
                </div>
            </form>
        `);

        const colorChips = [...document.querySelectorAll('#reading-note-form .category-chip')];
        colorChips.forEach(chip => {
            chip.addEventListener('click', () => {
                colorChips.forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
            });
        });

        document.getElementById('rn-cancel').addEventListener('click', () => this.closeModal());
        document.getElementById('reading-note-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const content = document.getElementById('rn-content').value.trim();
            if (!content) return;

            const color = document.querySelector('#reading-note-form .category-chip.active')?.dataset.color || 'yellow';

            await this.db.addReadingNote({
                sourceId: this.currentSource.id,
                text: data.text,
                note: content,
                color,
                startOffset: data.startOffset,
                endOffset: data.endOffset
            });

            this.closeModal();
            this.showToast('Reading note saved!', 'success');
            window.getSelection().removeAllRanges();
            await this.renderReader();
        });
    }

    async showReadingNoteDetail(noteId) {
        const notes = await this.db.getReadingNotesBySource(this.currentSource.id);
        const note = notes.find(n => n.id === noteId);
        if (!note) return;

        this.showModal(`
            <h3>📌 Reading Note</h3>
            <div class="selected-text-preview">${this.esc(note.text)}</div>
            <div class="detail-stack">
                <div>${this.esc(note.note)}</div>
                <div style="margin-top:8px;font-size:0.78rem;color:var(--text-muted);">${this.formatDateTime(note.createdAt)}</div>
            </div>
            <div class="form-actions">
                <button class="btn btn-danger btn-sm" id="rn-delete">🗑️ Delete</button>
                <button class="btn btn-primary" id="rn-close">Close</button>
            </div>
        `);

        document.getElementById('rn-close').addEventListener('click', () => this.closeModal());
        document.getElementById('rn-delete').addEventListener('click', async () => {
            if (!confirm('Delete this reading note?')) return;
            await this.db.deleteReadingNote(noteId);
            this.closeModal();
            this.showToast('Note deleted', 'success');
            await this.renderReader();
        });
    }

    async renderVocab() {
        const items = await this.db.getAllHighlights();
        const sources = await this.db.getAllSources();
        const sourceMap = {};
        for (const source of sources) sourceMap[source.id] = source;
        const categories = this.getUniqueCategories(items);
        const view = document.getElementById('view-vocab');

        view.innerHTML = `
            <div class="view-header">
                <h2>🔤 Study Items</h2>
                <div class="view-header-actions">
                    <span style="color:var(--text-secondary);font-size:0.85rem;">${items.length} items</span>
                    <button class="btn btn-primary" id="vocab-add-item">➕ Add Item</button>
                </div>
            </div>

            <div class="vocab-filters">
                <input type="text" id="vocab-search" placeholder="🔍 Search text, note, category...">
                <select id="vocab-filter-category">
                    <option value="">All Categories</option>
                    ${categories.map(category => `<option value="${this.esc(category)}">${this.esc(category)}</option>`).join('')}
                </select>
                <select id="vocab-filter-source">
                    <option value="">All Sources</option>
                    <option value="manual">Manual</option>
                    ${sources.map(source => `<option value="${source.id}">${this.esc(source.title)}</option>`).join('')}
                </select>
                <select id="vocab-filter-mastery">
                    <option value="">All Levels</option>
                    <option value="0">New</option>
                    <option value="1">Learning</option>
                    <option value="2">Familiar</option>
                    <option value="3">Known</option>
                    <option value="4">Strong</option>
                    <option value="5">Mastered</option>
                </select>
                <select id="vocab-sort">
                    <option value="newest">Newest First</option>
                    <option value="oldest">Oldest First</option>
                    <option value="alpha">A → Z</option>
                    <option value="chars-desc">Longest First</option>
                    <option value="mastery-desc">Mastery ↓</option>
                </select>
            </div>

            <div id="vocab-table-container">${this.renderVocabTable(items, sourceMap)}</div>
        `;

        const applyFilters = () => {
            const search = document.getElementById('vocab-search').value.toLowerCase();
            const category = document.getElementById('vocab-filter-category').value;
            const sourceId = document.getElementById('vocab-filter-source').value;
            const mastery = document.getElementById('vocab-filter-mastery').value;
            const sort = document.getElementById('vocab-sort').value;

            let filtered = [...items];
            if (search) {
                filtered = filtered.filter(item =>
                    item.text.toLowerCase().includes(search)
                    || (item.note || '').toLowerCase().includes(search)
                    || (item.category || '').toLowerCase().includes(search)
                    || this.getSourceLabel(item, sourceMap).toLowerCase().includes(search)
                );
            }
            if (category) filtered = filtered.filter(item => (item.category || 'General') === category);
            if (sourceId === 'manual') filtered = filtered.filter(item => !item.sourceId);
            if (sourceId && sourceId !== 'manual') filtered = filtered.filter(item => item.sourceId === parseInt(sourceId, 10));
            if (mastery !== '') filtered = filtered.filter(item => (item.masteryLevel || 0) === parseInt(mastery, 10));

            if (sort === 'newest') filtered.sort((a, b) => b.createdAt - a.createdAt);
            if (sort === 'oldest') filtered.sort((a, b) => a.createdAt - b.createdAt);
            if (sort === 'alpha') filtered.sort((a, b) => a.text.localeCompare(b.text));
            if (sort === 'chars-desc') filtered.sort((a, b) => (b.charCount || b.text.length) - (a.charCount || a.text.length));
            if (sort === 'mastery-desc') filtered.sort((a, b) => (b.masteryLevel || 0) - (a.masteryLevel || 0));

            document.getElementById('vocab-table-container').innerHTML = this.renderVocabTable(filtered, sourceMap);
            this.bindVocabTableEvents();
        };

        ['vocab-search', 'vocab-filter-category', 'vocab-filter-source', 'vocab-filter-mastery', 'vocab-sort'].forEach(id => {
            const el = document.getElementById(id);
            el.addEventListener(id === 'vocab-search' ? 'input' : 'change', applyFilters);
        });

        document.getElementById('vocab-add-item')?.addEventListener('click', () => {
            const selectedCategory = document.getElementById('vocab-filter-category')?.value || '';
            this.showQuickAddItemModal({ category: selectedCategory }, { title: 'Add New Item' });
        });

        this.bindVocabTableEvents();
    }

    renderVocabTable(items, sourceMap) {
        if (items.length === 0) {
            return '<div class="empty-state"><div class="empty-icon">🔤</div><p>No study items match your filters.</p></div>';
        }

        return `
            <table class="vocab-table">
                <thead>
                    <tr>
                        <th>Text</th>
                        <th>Note</th>
                        <th>Category</th>
                        <th>Source</th>
                        <th>Chars</th>
                        <th>Mastery</th>
                        <th>Added</th>
                    </tr>
                </thead>
                <tbody>
                    ${items.map(item => {
                        const level = item.masteryLevel || 0;
                        return `
                            <tr class="vocab-row" data-hl-id="${item.id}">
                                <td>
                                    <div class="vocab-text">${this.esc(item.text)}</div>
                                    ${item.context ? `<div class="vocab-context">${this.esc(item.context.substring(0, 80))}${item.context.length > 80 ? '…' : ''}</div>` : ''}
                                </td>
                                <td>${this.esc(item.note || '—')}</td>
                                <td><span class="tag">${this.esc(item.category || 'General')}</span></td>
                                <td style="font-size:0.78rem;color:var(--text-secondary);">${this.esc(this.getSourceLabel(item, sourceMap))}</td>
                                <td>${item.charCount || item.text.length}</td>
                                <td>
                                    <div class="mastery">
                                        ${[0, 1, 2, 3, 4].map(i => `<span class="mastery-dot ${i < level ? 'filled' : ''}"></span>`).join('')}
                                        <span class="mastery-label">${this.masteryName(level)}</span>
                                    </div>
                                </td>
                                <td style="font-size:0.78rem;color:var(--text-muted);white-space:nowrap;">${this.formatDate(item.createdAt)}</td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        `;
    }

    bindVocabTableEvents() {
        document.querySelectorAll('.vocab-row').forEach(row => {
            row.addEventListener('click', () => this.showHighlightDetailModal(parseInt(row.dataset.hlId, 10)));
        });
    }

    async renderReviewSetup() {
        const due = await this.db.getDueHighlights();
        const categories = this.getUniqueCategories(due);
        const filteredCount = this.reviewFilterCategory
            ? due.filter(item => (item.category || 'General') === this.reviewFilterCategory).length
            : due.length;
        const view = document.getElementById('view-review');

        view.innerHTML = `
            <div class="review-setup">
                <h2>🧠 Review Mode</h2>
                <p>Front shows only the prompt. Flip to reveal your note and details.</p>
                <div class="review-stat">${filteredCount}</div>
                <p style="color:var(--text-secondary);margin-bottom:20px;">items ready to review</p>
                <div class="review-filter-bar">
                    <label for="review-category">Category</label>
                    <select id="review-category">
                        <option value="">All Categories</option>
                        ${categories.map(category => `<option value="${this.esc(category)}" ${this.reviewFilterCategory === category ? 'selected' : ''}>${this.esc(category)}</option>`).join('')}
                    </select>
                </div>
                ${filteredCount > 0 ? `
                    <button class="btn btn-primary btn-lg" id="review-start-all">Start Review (${filteredCount})</button>
                    <div style="margin-top:16px;">
                        <button class="btn btn-secondary" id="review-start-10">Quick Review (10 items)</button>
                    </div>
                ` : `
                    <p style="color:var(--success);">✨ Nothing due in this view.</p>
                    <button class="btn btn-secondary" style="margin-top:16px;" id="review-browse">Browse Items</button>
                `}
            </div>
        `;

        document.getElementById('review-category')?.addEventListener('change', (e) => {
            this.reviewFilterCategory = e.target.value;
            this.renderReviewSetup();
        });
        document.getElementById('review-start-all')?.addEventListener('click', () => {
            this.startReviewSession(undefined, { category: this.reviewFilterCategory });
        });
        document.getElementById('review-start-10')?.addEventListener('click', () => {
            this.startReviewSession(10, { category: this.reviewFilterCategory });
        });
        document.getElementById('review-browse')?.addEventListener('click', () => this.navigate('vocab'));
    }

    async startReviewSession(limit, options = {}) {
        let due = await this.db.getDueHighlights();
        if (options.category) {
            due = due.filter(item => (item.category || 'General') === options.category);
        }

        for (let i = due.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [due[i], due[j]] = [due[j], due[i]];
        }

        if (limit) due = due.slice(0, limit);
        if (due.length === 0) {
            this.showToast('No items due for review', '');
            return;
        }

        this.reviewSession = {
            cards: due,
            index: 0,
            revealed: false,
            results: { again: 0, hard: 0, good: 0, easy: 0 }
        };

        this.showReviewCard();
    }

    showReviewCard() {
        const session = this.reviewSession;
        if (!session || session.index >= session.cards.length) {
            this.showReviewSummary();
            return;
        }

        const card = session.cards[session.index];
        const progress = (session.index / session.cards.length * 100).toFixed(0);
        const intervals = this.previewIntervals(card);
        const view = document.getElementById('view-review');

        view.innerHTML = `
            <div class="review-container">
                <div class="review-progress">
                    <div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>
                    <span class="progress-text">${session.index + 1} / ${session.cards.length}</span>
                </div>

                <div class="flashcard" id="flashcard">
                    <div class="flashcard-inner ${session.revealed ? 'is-revealed' : ''}">
                        <div class="card-label">${session.revealed ? 'Back' : 'Front'}</div>
                        <div class="card-text">${this.esc(card.text)}</div>
                        ${session.revealed ? `
                            <div class="card-divider"></div>
                            <div class="card-answer">
                                <div class="card-meaning">${this.esc(card.note || 'No note added')}</div>
                                <div class="card-meta-list">
                                    <span>${this.esc(card.category || 'General')}</span>
                                    <span>${card.charCount || card.text.length} chars</span>
                                    <span>${card.sourceId ? 'From text' : 'Manual'}</span>
                                </div>
                                ${card.context ? `<div class="card-context">${this.esc(card.context)}</div>` : ''}
                            </div>
                        ` : `
                            <div class="card-prompt">Click the card or press Space to reveal the note</div>
                        `}
                    </div>
                </div>

                ${session.revealed ? `
                    <div class="rating-buttons">
                        <button class="rating-btn again" data-rating="1">
                            <span class="rating-label">Again</span>
                            <span class="rating-interval">${intervals.again}</span>
                        </button>
                        <button class="rating-btn hard" data-rating="2">
                            <span class="rating-label">Hard</span>
                            <span class="rating-interval">${intervals.hard}</span>
                        </button>
                        <button class="rating-btn good" data-rating="3">
                            <span class="rating-label">Good</span>
                            <span class="rating-interval">${intervals.good}</span>
                        </button>
                        <button class="rating-btn easy" data-rating="4">
                            <span class="rating-label">Easy</span>
                            <span class="rating-interval">${intervals.easy}</span>
                        </button>
                    </div>
                ` : ''}
            </div>
        `;

        document.getElementById('flashcard').addEventListener('click', () => this.flipCard());
        document.querySelectorAll('.rating-btn').forEach(btn => {
            btn.addEventListener('click', () => this.rateCard(parseInt(btn.dataset.rating, 10)));
        });
    }

    flipCard() {
        if (!this.reviewSession) return;
        if (this.reviewSession.revealed) {
            this.rateCard(3);
            return;
        }
        this.reviewSession.revealed = true;
        this.showReviewCard();
    }

    previewIntervals(card) {
        const calc = (rating) => {
            const result = this.calculateSRS(card, rating);
            return this.formatInterval(result.interval);
        };

        return {
            again: calc(1),
            hard: calc(2),
            good: calc(3),
            easy: calc(4)
        };
    }

    calculateSRS(item, rating) {
        let interval = item.interval || 0;
        let ease = item.easeFactor || 2.5;
        let level = item.masteryLevel || 0;

        if (rating === 1) {
            interval = 1;
            ease = Math.max(1.3, ease - 0.2);
            level = 0;
        } else if (rating === 2) {
            interval = Math.max(1, Math.round(interval * 1.2));
            ease = Math.max(1.3, ease - 0.15);
        } else if (rating === 3) {
            if (interval < 1) interval = 1;
            else if (interval < 3) interval = 3;
            else interval = Math.round(interval * ease);
            level = Math.min(5, level + 1);
        } else if (rating === 4) {
            if (interval < 1) interval = 3;
            else if (interval < 3) interval = 7;
            else interval = Math.round(interval * ease * 1.3);
            ease = Math.min(3, ease + 0.15);
            level = Math.min(5, level + 1);
        }

        return { interval, easeFactor: ease, masteryLevel: level };
    }

    async rateCard(rating) {
        if (!this.reviewSession) return;

        const session = this.reviewSession;
        const card = session.cards[session.index];
        const names = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' };
        session.results[names[rating]]++;

        const srs = this.calculateSRS(card, rating);
        card.interval = srs.interval;
        card.easeFactor = srs.easeFactor;
        card.masteryLevel = srs.masteryLevel;
        card.lastReviewedAt = Date.now();
        card.nextReviewAt = Date.now() + srs.interval * 86400000;
        card.reviewCount = (card.reviewCount || 0) + 1;

        await this.db.updateHighlight(card);

        session.index++;
        session.revealed = false;
        this.showReviewCard();
        this.updateReviewBadge();
    }

    showReviewSummary() {
        const session = this.reviewSession;
        if (!session) return;

        const total = session.cards.length;
        const results = session.results;
        const view = document.getElementById('view-review');

        view.innerHTML = `
            <div class="review-summary">
                <h2>🎉 Review Complete!</h2>
                <div class="summary-stats">
                    <div class="summary-stat"><div class="value">${total}</div><div class="label">Cards Reviewed</div></div>
                    <div class="summary-stat"><div class="value" style="color:var(--danger)">${results.again}</div><div class="label">Again</div></div>
                    <div class="summary-stat"><div class="value" style="color:var(--warning)">${results.hard}</div><div class="label">Hard</div></div>
                    <div class="summary-stat"><div class="value" style="color:var(--success)">${results.good}</div><div class="label">Good</div></div>
                    <div class="summary-stat"><div class="value" style="color:var(--accent)">${results.easy}</div><div class="label">Easy</div></div>
                </div>
                <div style="margin-bottom:16px;"><button class="btn btn-primary btn-lg" id="summary-again">Review More</button></div>
                <button class="btn btn-secondary" id="summary-dashboard">Back to Dashboard</button>
            </div>
        `;

        this.reviewSession = null;
        document.getElementById('summary-again').addEventListener('click', () => this.renderReviewSetup());
        document.getElementById('summary-dashboard').addEventListener('click', () => this.navigate('dashboard'));
    }

    async exportData() {
        try {
            const data = await this.db.exportAll();
            const json = JSON.stringify(data, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `langlens-backup-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            this.showToast('Data exported!', 'success');
        } catch (e) {
            this.showToast('Export failed: ' + e.message, 'error');
        }
    }

    async importData(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data.sources || !data.highlights) {
                throw new Error('Invalid format');
            }
            if (!confirm(`Import ${data.sources.length} sources and ${data.highlights.length} items? This will replace all existing data.`)) {
                return;
            }
            const result = await this.db.importAll(data);
            this.showToast(`Imported ${result.sources} sources, ${result.highlights} items!`, 'success');
            this.navigate(this.currentView);
            this.updateReviewBadge();
        } catch (e) {
            this.showToast('Import failed: ' + e.message, 'error');
        }
    }
}

const app = new App();
app.init().catch(err => {
    console.error('Failed to initialize LangLens:', err);
    document.getElementById('main').innerHTML = `
        <div style="padding:40px;text-align:center;color:var(--danger);">
            <h2>Failed to initialize</h2>
            <p>${err.message}</p>
            <p style="color:var(--text-secondary);margin-top:8px;">Make sure your browser supports IndexedDB.</p>
        </div>
    `;
});