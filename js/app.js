/**
 * LangLens - Main Application Logic
 * Handles views, events, reader highlighting, SRS review
 */

class App {
    constructor() {
        this.db = new Database();
        this.currentView = 'dashboard';
        this.currentSource = null;
        this.reviewSession = null;
        this._pendingSelection = null;
        this._selectionHandler = null;
    }

    async init() {
        await this.db.init();
        this.bindEvents();
        this.navigate('dashboard');
        this.updateReviewBadge();
    }

    // === Utilities ===

    esc(str) {
        const d = document.createElement('div');
        d.textContent = str;
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
        } else {
            if (mins < 60) return `in ${mins}m`;
            if (hours < 24) return `in ${hours}h`;
            return `in ${days}d`;
        }
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
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.className = `toast ${type ? 'toast-' + type : ''}`;
        t.classList.remove('hidden');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => t.classList.add('hidden'), 2500);
    }

    extractContext(content, start, end, maxLen = 120) {
        const enders = /[.!?。！？\n\r]/;
        let cs = start;
        for (let i = start - 1; i >= Math.max(0, start - maxLen); i--) {
            if (enders.test(content[i])) { cs = i + 1; break; }
            cs = i;
        }
        let ce = end;
        for (let i = end; i < Math.min(content.length, end + maxLen); i++) {
            ce = i + 1;
            if (enders.test(content[i])) break;
        }
        return content.substring(cs, ce).trim();
    }

    // === Events ===

    bindEvents() {
        // Navigation
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                this.navigate(link.dataset.view);
            });
        });

        // Selection toolbar buttons
        document.querySelectorAll('#selection-toolbar .st-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const type = btn.dataset.type;
                if (this._pendingSelection) {
                    this.showSaveHighlightModal({ ...this._pendingSelection, type });
                }
                this.hideSelectionToolbar();
            });
        });

        // Close modal on overlay click
        document.getElementById('modal-overlay').addEventListener('click', (e) => {
            if (e.target.id === 'modal-overlay') this.closeModal();
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeModal();
                this.hideSelectionToolbar();
            }
            // Review shortcuts
            if (this.currentView === 'review' && this.reviewSession && this.reviewSession.revealed) {
                if (e.key === '1') this.rateCard(1);
                else if (e.key === '2') this.rateCard(2);
                else if (e.key === '3') this.rateCard(3);
                else if (e.key === '4') this.rateCard(4);
            }
            if (this.currentView === 'review' && this.reviewSession && !this.reviewSession.revealed && e.key === ' ') {
                e.preventDefault();
                this.flipCard();
            }
        });

        // Hide selection toolbar on outside click
        document.addEventListener('mousedown', (e) => {
            const toolbar = document.getElementById('selection-toolbar');
            if (!toolbar.contains(e.target)) {
                this.hideSelectionToolbar();
            }
        });

        // Export
        document.getElementById('btn-export').addEventListener('click', () => this.exportData());

        // Import
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

    // === Navigation ===

    navigate(viewName) {
        this.currentView = viewName;

        // Update nav links
        document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
        const active = document.querySelector(`.nav-link[data-view="${viewName}"]`);
        if (active) active.classList.add('active');

        // Show/hide views
        document.querySelectorAll('.view').forEach(v => {
            v.classList.remove('active');
            v.classList.add('hidden');
        });
        const view = document.getElementById(`view-${viewName}`);
        if (view) {
            view.classList.remove('hidden');
            view.classList.add('active');
        }

        // Remove reader selection handler when leaving reader
        if (viewName !== 'reader' && this._selectionHandler) {
            document.removeEventListener('mouseup', this._selectionHandler);
            this._selectionHandler = null;
        }

        // Render the view
        switch (viewName) {
            case 'dashboard': this.renderDashboard(); break;
            case 'library': this.renderLibrary(); break;
            case 'vocab': this.renderVocab(); break;
            case 'review': this.renderReviewSetup(); break;
        }

        // Scroll to top
        document.getElementById('main').scrollTop = 0;
    }

    // === Modal ===

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

    // === Review Badge ===

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

    // ============================
    //         DASHBOARD
    // ============================

    async renderDashboard() {
        const stats = await this.db.getStats();
        const highlights = await this.db.getAllHighlights();
        const sources = await this.db.getAllSources();
        const recent = highlights.sort((a, b) => b.createdAt - a.createdAt).slice(0, 8);

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
                    <div class="stat-icon">🔤</div>
                    <div class="stat-value">${stats.totalHighlights}</div>
                    <div class="stat-label">Total Items</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">📚</div>
                    <div class="stat-value">${stats.totalSources}</div>
                    <div class="stat-label">Sources</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">🔥</div>
                    <div class="stat-value">${stats.streak}</div>
                    <div class="stat-label">Day Streak</div>
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
                <button class="btn btn-primary btn-lg" id="dash-review" ${stats.dueCount === 0 ? 'disabled' : ''}>
                    🧠 Start Review ${stats.dueCount > 0 ? `(${stats.dueCount})` : ''}
                </button>
                <button class="btn btn-secondary btn-lg" id="dash-add">
                    ➕ Add New Text
                </button>
            </div>

            ${recent.length > 0 ? `
                <div class="section-title">Recently Added</div>
                <div class="recent-list">
                    ${recent.map(h => {
                        const src = sources.find(s => s.id === h.sourceId);
                        return `
                            <div class="recent-item" data-hl-id="${h.id}" data-source-id="${h.sourceId}">
                                <span class="hl-type-dot dot-${h.type}"></span>
                                <span class="ri-text">${this.esc(h.text)}</span>
                                ${h.note ? `<span style="color:var(--text-secondary);font-size:0.8rem;flex-shrink:0;">${this.esc(h.note.substring(0, 30))}</span>` : ''}
                                <span class="ri-meta">${this.formatDateTime(h.createdAt)}</span>
                            </div>
                        `;
                    }).join('')}
                </div>
            ` : `
                <div class="empty-state">
                    <div class="empty-icon">📖</div>
                    <p>No items yet. Import a text and start highlighting vocabulary!</p>
                </div>
            `}
        `;

        // Bind dashboard events
        const reviewBtn = document.getElementById('dash-review');
        if (reviewBtn) reviewBtn.addEventListener('click', () => {
            this.navigate('review');
            setTimeout(() => this.startReviewSession(), 100);
        });
        document.getElementById('dash-add')?.addEventListener('click', () => this.showAddSourceModal());

        // Click recent item to navigate to reader
        view.querySelectorAll('.recent-item').forEach(item => {
            item.addEventListener('click', () => {
                const sourceId = parseInt(item.dataset.sourceId);
                if (sourceId) this.openReader(sourceId);
            });
        });
    }

    // ============================
    //          LIBRARY
    // ============================

    async renderLibrary() {
        const sources = await this.db.getAllSources();
        const highlights = await this.db.getAllHighlights();
        const view = document.getElementById('view-library');

        // Count highlights per source
        const hlCounts = {};
        for (const h of highlights) {
            hlCounts[h.sourceId] = (hlCounts[h.sourceId] || 0) + 1;
        }

        const sorted = sources.sort((a, b) => b.createdAt - a.createdAt);

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
                    <p>Your library is empty. Add your first text source to get started!</p>
                    <button class="btn btn-primary" id="lib-add-empty">➕ Add Your First Text</button>
                </div>
            ` : `
                <div class="cards-grid">
                    ${sorted.map(src => `
                        <div class="source-card" data-id="${src.id}">
                            <div class="card-header">
                                <div class="card-title">${this.esc(src.title)}</div>
                                <span class="type-badge ${src.sourceType}">${src.sourceType}</span>
                            </div>
                            <div class="card-preview">${this.esc(src.content.substring(0, 200))}</div>
                            <div class="card-meta">
                                <span>🔤 ${hlCounts[src.id] || 0} highlights</span>
                                <span>${this.formatDate(src.createdAt)}</span>
                                ${src.language ? `<span>🌐 ${this.esc(src.language)}</span>` : ''}
                            </div>
                            ${src.tags && src.tags.length > 0 ? `
                                <div class="card-tags">
                                    ${src.tags.map(t => `<span class="tag">${this.esc(t)}</span>`).join('')}
                                </div>
                            ` : ''}
                        </div>
                    `).join('')}
                </div>
            `}
        `;

        // Events
        document.getElementById('lib-add')?.addEventListener('click', () => this.showAddSourceModal());
        document.getElementById('lib-add-empty')?.addEventListener('click', () => this.showAddSourceModal());

        view.querySelectorAll('.source-card').forEach(card => {
            card.addEventListener('click', () => {
                this.openReader(parseInt(card.dataset.id));
            });
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
                        <input type="text" id="src-lang" placeholder="e.g., Japanese, Korean..." value="Japanese">
                    </div>
                </div>
                <div class="form-group">
                    <label>Tags <span class="form-hint">(comma-separated)</span></label>
                    <input type="text" id="src-tags" placeholder="e.g., N3, news, daily-conversation">
                </div>
                <div class="form-group">
                    <label>Content</label>
                    <textarea id="src-content" rows="10" placeholder="Paste your text content here..." required></textarea>
                </div>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" id="src-cancel">Cancel</button>
                    <button type="submit" class="btn btn-primary">💾 Save</button>
                </div>
            </form>
        `, { size: 'modal-lg' });

        document.getElementById('src-cancel').addEventListener('click', () => this.closeModal());
        document.getElementById('add-source-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const title = document.getElementById('src-title').value.trim();
            const content = document.getElementById('src-content').value;
            if (!title || !content) return;

            const tags = document.getElementById('src-tags').value
                .split(',').map(t => t.trim()).filter(Boolean);

            const id = await this.db.addSource({
                title,
                content,
                sourceType: document.getElementById('src-type').value,
                language: document.getElementById('src-lang').value.trim(),
                tags
            });

            this.closeModal();
            this.showToast('Text added to library!', 'success');
            if (this.currentView === 'library') this.renderLibrary();
            else if (this.currentView === 'dashboard') this.renderDashboard();
        });
    }

    // ============================
    //          READER
    // ============================

    async openReader(sourceId) {
        const source = await this.db.getSource(sourceId);
        if (!source) {
            this.showToast('Source not found', 'error');
            return;
        }
        this.currentSource = source;

        // Switch to reader view without re-rendering other views
        this.currentView = 'reader';
        document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
        document.querySelector('.nav-link[data-view="library"]')?.classList.add('active');
        document.querySelectorAll('.view').forEach(v => {
            v.classList.remove('active');
            v.classList.add('hidden');
        });
        const view = document.getElementById('view-reader');
        view.classList.remove('hidden');
        view.classList.add('active');

        await this.renderReader();
    }

    async renderReader() {
        if (!this.currentSource) return;
        const source = this.currentSource;
        const highlights = await this.db.getHighlightsBySource(source.id);
        const view = document.getElementById('view-reader');

        view.innerHTML = `
            <button class="reader-back" id="reader-back">← Back to Library</button>
            <div class="reader-source-info">
                <h2>${this.esc(source.title)}</h2>
                <div class="meta">
                    <span class="type-badge ${source.sourceType}">${source.sourceType}</span>
                    ${source.language ? `<span>🌐 ${this.esc(source.language)}</span>` : ''}
                    <span>${this.formatDate(source.createdAt)}</span>
                    <span>🔤 ${highlights.length} highlights</span>
                    <button class="btn btn-sm btn-secondary" id="reader-edit-source" title="Edit source">✏️</button>
                    <button class="btn btn-sm btn-secondary" id="reader-delete-source" title="Delete source" style="color:var(--danger)">🗑️</button>
                </div>
            </div>
            <div class="reader-layout">
                <div class="reader-text-area">
                    <div id="reader-content">${this.renderTextContent(source.content, highlights)}</div>
                </div>
                <div class="reader-sidebar">
                    <h3>Highlights (${highlights.length})</h3>
                    <div id="reader-hl-list">
                        ${highlights.length === 0 ? '<p style="color:var(--text-muted);font-size:0.82rem;">Select text and mark it as vocab, grammar, or phrase.</p>' : ''}
                        ${highlights.sort((a, b) => a.startOffset - b.startOffset).map(h => `
                            <div class="hl-list-item" data-hl-id="${h.id}">
                                <div class="hl-text">
                                    <span class="hl-type-dot dot-${h.type}"></span>
                                    ${this.esc(h.text)}
                                </div>
                                ${h.reading ? `<div style="color:var(--purple);font-size:0.78rem;">${this.esc(h.reading)}</div>` : ''}
                                ${h.note ? `<div class="hl-note">${this.esc(h.note)}</div>` : ''}
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>
        `;

        // Bind events
        document.getElementById('reader-back').addEventListener('click', () => this.navigate('library'));

        document.getElementById('reader-delete-source')?.addEventListener('click', async () => {
            if (confirm(`Delete "${source.title}" and all its highlights?`)) {
                await this.db.deleteSource(source.id);
                this.currentSource = null;
                this.showToast('Source deleted', 'success');
                this.navigate('library');
                this.updateReviewBadge();
            }
        });

        document.getElementById('reader-edit-source')?.addEventListener('click', () => {
            this.showEditSourceModal(source);
        });

        // Click highlight in sidebar → show detail
        view.querySelectorAll('.hl-list-item').forEach(item => {
            item.addEventListener('click', () => {
                this.showHighlightDetailModal(parseInt(item.dataset.hlId));
            });
        });

        // Click highlight in text → show detail
        view.querySelectorAll('.hl[data-hl-id]').forEach(span => {
            span.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showHighlightDetailModal(parseInt(span.dataset.hlId));
            });
        });

        // Text selection handling
        if (this._selectionHandler) {
            document.removeEventListener('mouseup', this._selectionHandler);
        }
        this._selectionHandler = (e) => this.handleTextSelection(e);
        document.addEventListener('mouseup', this._selectionHandler);

        document.getElementById('main').scrollTop = 0;
    }

    renderTextContent(content, highlights) {
        const sorted = [...highlights].sort((a, b) => a.startOffset - b.startOffset);

        // Remove overlapping highlights (keep earlier ones)
        const clean = [];
        let lastEnd = 0;
        for (const h of sorted) {
            if (h.startOffset >= lastEnd) {
                clean.push(h);
                lastEnd = h.endOffset;
            }
        }

        let html = '';
        let pos = 0;

        for (const h of clean) {
            if (h.startOffset > pos) {
                html += `<span class="seg" data-offset="${pos}">${this.esc(content.substring(pos, h.startOffset))}</span>`;
            }
            const tooltip = this.esc((h.reading ? h.reading + ' — ' : '') + (h.note || ''));
            html += `<span class="seg hl hl-${h.type}" data-offset="${h.startOffset}" data-hl-id="${h.id}" title="${tooltip}">${this.esc(content.substring(h.startOffset, h.endOffset))}</span>`;
            pos = h.endOffset;
        }

        if (pos < content.length) {
            html += `<span class="seg" data-offset="${pos}">${this.esc(content.substring(pos))}</span>`;
        }

        return html;
    }

    getSourceOffset(node, charOffset) {
        let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;

        // Walk up to find element with data-offset
        while (el && el.getAttribute && el.getAttribute('data-offset') === null) {
            el = el.parentElement;
        }
        if (!el || !el.getAttribute || el.getAttribute('data-offset') === null) return -1;

        const baseOffset = parseInt(el.getAttribute('data-offset'));

        if (node.nodeType === Node.TEXT_NODE) {
            // Find char position within the segment
            let pos = 0;
            for (const child of el.childNodes) {
                if (child === node) { pos += charOffset; break; }
                pos += child.textContent.length;
            }
            return baseOffset + pos;
        } else {
            // Element node: charOffset is child index
            let pos = 0;
            for (let i = 0; i < charOffset && i < el.childNodes.length; i++) {
                pos += el.childNodes[i].textContent.length;
            }
            return baseOffset + pos;
        }
    }

    handleTextSelection(e) {
        if (this.currentView !== 'reader' || !this.currentSource) return;

        const sel = window.getSelection();
        const text = sel.toString().trim();
        if (!text) return;

        const readerContent = document.getElementById('reader-content');
        if (!readerContent) return;

        const range = sel.getRangeAt(0);
        if (!readerContent.contains(range.commonAncestorContainer)) return;

        // Don't trigger on highlight clicks
        const clickedHl = e.target.closest && e.target.closest('.hl[data-hl-id]');
        if (clickedHl && text === clickedHl.textContent.trim()) return;

        const startOffset = this.getSourceOffset(range.startContainer, range.startOffset);
        const endOffset = this.getSourceOffset(range.endContainer, range.endOffset);

        if (startOffset === -1 || endOffset === -1 || startOffset >= endOffset) return;

        this._pendingSelection = {
            text,
            startOffset,
            endOffset,
            context: this.extractContext(this.currentSource.content, startOffset, endOffset)
        };

        // Position toolbar near selection
        const rect = range.getBoundingClientRect();
        const toolbar = document.getElementById('selection-toolbar');
        toolbar.style.top = `${rect.top - 48}px`;
        toolbar.style.left = `${rect.left + rect.width / 2}px`;
        toolbar.classList.remove('hidden');
    }

    showSaveHighlightModal(data) {
        this.showModal(`
            <h3>💾 Save ${data.type.charAt(0).toUpperCase() + data.type.slice(1)}</h3>
            <div class="selected-text-preview">${this.esc(data.text)}</div>
            <form id="save-hl-form">
                <div class="form-group">
                    <label>Type</label>
                    <div class="radio-group">
                        <label><input type="radio" name="hl-type" value="vocab" ${data.type === 'vocab' ? 'checked' : ''}> 📝 Vocab</label>
                        <label><input type="radio" name="hl-type" value="grammar" ${data.type === 'grammar' ? 'checked' : ''}> 📐 Grammar</label>
                        <label><input type="radio" name="hl-type" value="phrase" ${data.type === 'phrase' ? 'checked' : ''}> 💬 Phrase</label>
                    </div>
                </div>
                <div class="form-group">
                    <label>Reading / Pronunciation</label>
                    <input type="text" id="hl-reading" placeholder="e.g., たべる, taberu...">
                    <span class="form-hint">Furigana, romaji, or phonetic reading</span>
                </div>
                <div class="form-group">
                    <label>Meaning / Notes</label>
                    <textarea id="hl-note" rows="3" placeholder="e.g., to eat, 食べる means..."></textarea>
                </div>
                <div class="form-group">
                    <label>Tags <span class="form-hint">(comma-separated)</span></label>
                    <input type="text" id="hl-tags" placeholder="e.g., verb, N3, food">
                </div>
                <div class="form-group">
                    <label>Context</label>
                    <div style="font-size:0.85rem;color:var(--text-secondary);padding:8px 12px;background:var(--bg-card);border-radius:var(--radius);font-family:var(--font-jp);line-height:1.8;">
                        ${this.esc(data.context)}
                    </div>
                </div>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" id="hl-cancel">Cancel</button>
                    <button type="submit" class="btn btn-primary">💾 Save</button>
                </div>
            </form>
        `);

        document.getElementById('hl-cancel').addEventListener('click', () => this.closeModal());
        document.getElementById('save-hl-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const type = document.querySelector('input[name="hl-type"]:checked').value;
            const tags = document.getElementById('hl-tags').value
                .split(',').map(t => t.trim()).filter(Boolean);

            await this.db.addHighlight({
                sourceId: this.currentSource.id,
                text: data.text,
                startOffset: data.startOffset,
                endOffset: data.endOffset,
                context: data.context,
                type,
                reading: document.getElementById('hl-reading').value.trim(),
                note: document.getElementById('hl-note').value.trim(),
                tags
            });

            this.closeModal();
            this.showToast('Highlight saved!', 'success');
            window.getSelection().removeAllRanges();
            await this.renderReader();
            this.updateReviewBadge();
        });
    }

    async showHighlightDetailModal(hlId) {
        const hl = await this.db.getHighlight(hlId);
        if (!hl) return;
        const source = await this.db.getSource(hl.sourceId);

        this.showModal(`
            <h3>
                <span class="hl-type-dot dot-${hl.type}"></span>
                ${hl.type.charAt(0).toUpperCase() + hl.type.slice(1)} Detail
            </h3>
            <div class="selected-text-preview">${this.esc(hl.text)}</div>

            ${hl.reading ? `<div style="color:var(--purple);font-size:1rem;margin-bottom:12px;font-family:var(--font-jp);">🔊 ${this.esc(hl.reading)}</div>` : ''}
            ${hl.note ? `<div style="margin-bottom:12px;"><strong>Notes:</strong> ${this.esc(hl.note)}</div>` : ''}
            ${hl.context ? `
                <div style="margin-bottom:12px;">
                    <strong>Context:</strong>
                    <div style="font-size:0.85rem;color:var(--text-secondary);padding:8px 12px;background:var(--bg-card);border-radius:var(--radius);font-family:var(--font-jp);line-height:1.8;margin-top:4px;">
                        ${this.esc(hl.context)}
                    </div>
                </div>
            ` : ''}
            <div style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:8px;">
                ${source ? `📚 ${this.esc(source.title)}` : ''} · Added ${this.formatDateTime(hl.createdAt)}
            </div>
            <div style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:16px;">
                Mastery: ${this.masteryName(hl.masteryLevel)} · Reviews: ${hl.reviewCount}
                ${hl.nextReviewAt ? ` · Next: ${this.relativeTime(hl.nextReviewAt)}` : ''}
            </div>
            ${hl.tags && hl.tags.length > 0 ? `
                <div style="margin-bottom:16px;">${hl.tags.map(t => `<span class="tag">${this.esc(t)}</span>`).join(' ')}</div>
            ` : ''}

            <div class="form-actions">
                <button class="btn btn-danger btn-sm" id="hl-delete">🗑️ Delete</button>
                <button class="btn btn-secondary" id="hl-edit">✏️ Edit</button>
                <button class="btn btn-primary" id="hl-close">Close</button>
            </div>
        `);

        document.getElementById('hl-close').addEventListener('click', () => this.closeModal());
        document.getElementById('hl-delete').addEventListener('click', async () => {
            if (confirm('Delete this highlight?')) {
                await this.db.deleteHighlight(hlId);
                this.closeModal();
                this.showToast('Highlight deleted', 'success');
                if (this.currentView === 'reader') await this.renderReader();
                else if (this.currentView === 'vocab') this.renderVocab();
                this.updateReviewBadge();
            }
        });
        document.getElementById('hl-edit').addEventListener('click', () => {
            this.closeModal();
            this.showEditHighlightModal(hl);
        });
    }

    showEditHighlightModal(hl) {
        this.showModal(`
            <h3>✏️ Edit Highlight</h3>
            <div class="selected-text-preview">${this.esc(hl.text)}</div>
            <form id="edit-hl-form">
                <div class="form-group">
                    <label>Type</label>
                    <div class="radio-group">
                        <label><input type="radio" name="hl-type" value="vocab" ${hl.type === 'vocab' ? 'checked' : ''}> 📝 Vocab</label>
                        <label><input type="radio" name="hl-type" value="grammar" ${hl.type === 'grammar' ? 'checked' : ''}> 📐 Grammar</label>
                        <label><input type="radio" name="hl-type" value="phrase" ${hl.type === 'phrase' ? 'checked' : ''}> 💬 Phrase</label>
                    </div>
                </div>
                <div class="form-group">
                    <label>Reading / Pronunciation</label>
                    <input type="text" id="hl-reading" value="${this.esc(hl.reading || '')}">
                </div>
                <div class="form-group">
                    <label>Meaning / Notes</label>
                    <textarea id="hl-note" rows="3">${this.esc(hl.note || '')}</textarea>
                </div>
                <div class="form-group">
                    <label>Tags</label>
                    <input type="text" id="hl-tags" value="${this.esc((hl.tags || []).join(', '))}">
                </div>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" id="hl-cancel">Cancel</button>
                    <button type="submit" class="btn btn-primary">💾 Update</button>
                </div>
            </form>
        `);

        document.getElementById('hl-cancel').addEventListener('click', () => this.closeModal());
        document.getElementById('edit-hl-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            hl.type = document.querySelector('input[name="hl-type"]:checked').value;
            hl.reading = document.getElementById('hl-reading').value.trim();
            hl.note = document.getElementById('hl-note').value.trim();
            hl.tags = document.getElementById('hl-tags').value.split(',').map(t => t.trim()).filter(Boolean);

            await this.db.updateHighlight(hl);
            this.closeModal();
            this.showToast('Highlight updated!', 'success');
            if (this.currentView === 'reader') await this.renderReader();
            else if (this.currentView === 'vocab') this.renderVocab();
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
        `, { size: '' });

        document.getElementById('src-cancel').addEventListener('click', () => this.closeModal());
        document.getElementById('edit-source-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            source.title = document.getElementById('src-title').value.trim();
            source.sourceType = document.getElementById('src-type').value;
            source.language = document.getElementById('src-lang').value.trim();
            source.tags = document.getElementById('src-tags').value.split(',').map(t => t.trim()).filter(Boolean);
            await this.db.updateSource(source);
            this.closeModal();
            this.showToast('Source updated!', 'success');
            this.currentSource = source;
            await this.renderReader();
        });
    }

    // ============================
    //        VOCABULARY BANK
    // ============================

    async renderVocab(filters = {}) {
        const highlights = await this.db.getAllHighlights();
        const sources = await this.db.getAllSources();
        const sourceMap = {};
        for (const s of sources) sourceMap[s.id] = s;

        const view = document.getElementById('view-vocab');

        // Collect unique tags
        const allTags = new Set();
        for (const h of highlights) {
            (h.tags || []).forEach(t => allTags.add(t));
        }

        view.innerHTML = `
            <div class="view-header">
                <h2>🔤 Vocabulary Bank</h2>
                <span style="color:var(--text-secondary);font-size:0.85rem;">${highlights.length} items</span>
            </div>

            <div class="vocab-filters">
                <input type="text" id="vocab-search" placeholder="🔍 Search text, notes, reading...">
                <select id="vocab-filter-type">
                    <option value="">All Types</option>
                    <option value="vocab">📝 Vocab</option>
                    <option value="grammar">📐 Grammar</option>
                    <option value="phrase">💬 Phrase</option>
                </select>
                <select id="vocab-filter-source">
                    <option value="">All Sources</option>
                    ${sources.map(s => `<option value="${s.id}">${this.esc(s.title)}</option>`).join('')}
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
                    <option value="mastery-asc">Mastery ↑</option>
                    <option value="mastery-desc">Mastery ↓</option>
                </select>
            </div>

            <div id="vocab-table-container">
                ${this.renderVocabTable(highlights, sourceMap)}
            </div>
        `;

        // Filter / sort events
        const applyFilters = () => {
            const search = document.getElementById('vocab-search').value.toLowerCase();
            const type = document.getElementById('vocab-filter-type').value;
            const sourceId = document.getElementById('vocab-filter-source').value;
            const mastery = document.getElementById('vocab-filter-mastery').value;
            const sort = document.getElementById('vocab-sort').value;

            let filtered = [...highlights];

            if (search) {
                filtered = filtered.filter(h =>
                    h.text.toLowerCase().includes(search) ||
                    (h.note || '').toLowerCase().includes(search) ||
                    (h.reading || '').toLowerCase().includes(search) ||
                    (h.tags || []).some(t => t.toLowerCase().includes(search))
                );
            }
            if (type) filtered = filtered.filter(h => h.type === type);
            if (sourceId) filtered = filtered.filter(h => h.sourceId === parseInt(sourceId));
            if (mastery !== '') filtered = filtered.filter(h => (h.masteryLevel || 0) === parseInt(mastery));

            switch (sort) {
                case 'newest': filtered.sort((a, b) => b.createdAt - a.createdAt); break;
                case 'oldest': filtered.sort((a, b) => a.createdAt - b.createdAt); break;
                case 'alpha': filtered.sort((a, b) => a.text.localeCompare(b.text)); break;
                case 'mastery-asc': filtered.sort((a, b) => (a.masteryLevel || 0) - (b.masteryLevel || 0)); break;
                case 'mastery-desc': filtered.sort((a, b) => (b.masteryLevel || 0) - (a.masteryLevel || 0)); break;
            }

            document.getElementById('vocab-table-container').innerHTML = this.renderVocabTable(filtered, sourceMap);
            this.bindVocabTableEvents();
        };

        ['vocab-search', 'vocab-filter-type', 'vocab-filter-source', 'vocab-filter-mastery', 'vocab-sort']
            .forEach(id => {
                const el = document.getElementById(id);
                el.addEventListener(id === 'vocab-search' ? 'input' : 'change', applyFilters);
            });

        this.bindVocabTableEvents();
    }

    renderVocabTable(highlights, sourceMap) {
        if (highlights.length === 0) {
            return `<div class="empty-state"><div class="empty-icon">🔤</div><p>No vocabulary items match your filters.</p></div>`;
        }

        return `
            <table class="vocab-table">
                <thead>
                    <tr>
                        <th>Type</th>
                        <th>Text</th>
                        <th>Reading</th>
                        <th>Meaning</th>
                        <th>Source</th>
                        <th>Mastery</th>
                        <th>Added</th>
                    </tr>
                </thead>
                <tbody>
                    ${highlights.map(h => {
                        const src = sourceMap[h.sourceId];
                        const level = h.masteryLevel || 0;
                        return `
                            <tr class="vocab-row" data-hl-id="${h.id}">
                                <td><span class="hl-type-dot dot-${h.type}"></span></td>
                                <td>
                                    <div class="vocab-text">${this.esc(h.text)}</div>
                                    ${h.context ? `<div class="vocab-context">${this.esc(h.context.substring(0, 60))}...</div>` : ''}
                                </td>
                                <td class="vocab-reading">${this.esc(h.reading || '—')}</td>
                                <td>${this.esc(h.note || '—')}</td>
                                <td style="font-size:0.78rem;color:var(--text-secondary);">${src ? this.esc(src.title.substring(0, 25)) : '—'}</td>
                                <td>
                                    <div class="mastery">
                                        ${[0,1,2,3,4].map(i => `<span class="mastery-dot ${i < level ? 'filled' : ''}"></span>`).join('')}
                                        <span class="mastery-label">${this.masteryName(level)}</span>
                                    </div>
                                </td>
                                <td style="font-size:0.78rem;color:var(--text-muted);white-space:nowrap;">${this.formatDate(h.createdAt)}</td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        `;
    }

    bindVocabTableEvents() {
        document.querySelectorAll('.vocab-row').forEach(row => {
            row.addEventListener('click', () => {
                this.showHighlightDetailModal(parseInt(row.dataset.hlId));
            });
        });
    }

    // ============================
    //       REVIEW (SRS)
    // ============================

    async renderReviewSetup() {
        const due = await this.db.getDueHighlights();
        const view = document.getElementById('view-review');

        view.innerHTML = `
            <div class="review-setup">
                <h2>🧠 Review Mode</h2>
                <p>Study your saved items with spaced repetition</p>
                <div class="review-stat">${due.length}</div>
                <p style="color:var(--text-secondary);margin-bottom:32px;">items due for review</p>
                ${due.length > 0 ? `
                    <button class="btn btn-primary btn-lg" id="review-start-all">
                        Start Review (All ${due.length})
                    </button>
                    <div style="margin-top:16px;">
                        <button class="btn btn-secondary" id="review-start-10">
                            Quick Review (10 items)
                        </button>
                    </div>
                ` : `
                    <p style="color:var(--success);">✨ All caught up! No items due for review.</p>
                    <button class="btn btn-secondary" style="margin-top:16px;" id="review-browse">
                        Browse Vocabulary
                    </button>
                `}
            </div>
        `;

        document.getElementById('review-start-all')?.addEventListener('click', () => this.startReviewSession());
        document.getElementById('review-start-10')?.addEventListener('click', () => this.startReviewSession(10));
        document.getElementById('review-browse')?.addEventListener('click', () => this.navigate('vocab'));
    }

    async startReviewSession(limit) {
        let due = await this.db.getDueHighlights();

        // Shuffle
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
        const view = document.getElementById('view-review');
        const progress = ((session.index) / session.cards.length * 100).toFixed(0);

        // Calculate preview intervals for rating buttons
        const intervals = this.previewIntervals(card);

        view.innerHTML = `
            <div class="review-container">
                <div class="review-progress">
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${progress}%"></div>
                    </div>
                    <span class="progress-text">${session.index + 1} / ${session.cards.length}</span>
                </div>

                <div class="flashcard" id="flashcard">
                    <div class="flashcard-inner">
                        <div class="card-text">${this.esc(card.text)}</div>
                        ${card.context ? `
                            <div class="card-context">${this.esc(card.context).replace(this.esc(card.text), `<mark>${this.esc(card.text)}</mark>`)}</div>
                        ` : ''}

                        ${session.revealed ? `
                            <div class="card-divider"></div>
                            <div class="card-answer">
                                ${card.reading ? `<div class="card-reading">🔊 ${this.esc(card.reading)}</div>` : ''}
                                ${card.note ? `<div class="card-meaning">${this.esc(card.note)}</div>` : '<div class="card-meaning" style="color:var(--text-muted);">No notes added</div>'}
                            </div>
                            <div class="card-source">
                                <span class="hl-type-dot dot-${card.type}"></span> ${card.type} · Mastery: ${this.masteryName(card.masteryLevel || 0)} · Reviews: ${card.reviewCount || 0}
                            </div>
                        ` : `
                            <div class="card-prompt">Click or press Space to reveal answer</div>
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

        // Bind events
        if (!session.revealed) {
            document.getElementById('flashcard').addEventListener('click', () => this.flipCard());
        }

        document.querySelectorAll('.rating-btn').forEach(btn => {
            btn.addEventListener('click', () => this.rateCard(parseInt(btn.dataset.rating)));
        });
    }

    flipCard() {
        if (!this.reviewSession || this.reviewSession.revealed) return;
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

    calculateSRS(highlight, rating) {
        let interval = highlight.interval || 0;
        let ease = highlight.easeFactor || 2.5;
        let level = highlight.masteryLevel || 0;

        if (rating === 1) { // Again
            interval = 1;
            ease = Math.max(1.3, ease - 0.2);
            level = 0;
        } else if (rating === 2) { // Hard
            interval = Math.max(1, Math.round(interval * 1.2));
            ease = Math.max(1.3, ease - 0.15);
        } else if (rating === 3) { // Good
            if (interval < 1) interval = 1;
            else if (interval < 3) interval = 3;
            else interval = Math.round(interval * ease);
            level = Math.min(5, level + 1);
        } else if (rating === 4) { // Easy
            if (interval < 1) interval = 3;
            else if (interval < 3) interval = 7;
            else interval = Math.round(interval * ease * 1.3);
            ease = Math.min(3.0, ease + 0.15);
            level = Math.min(5, level + 1);
        }

        return { interval, easeFactor: ease, masteryLevel: level };
    }

    async rateCard(rating) {
        if (!this.reviewSession) return;
        const session = this.reviewSession;
        const card = session.cards[session.index];

        // Track result
        const names = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' };
        session.results[names[rating]]++;

        // Calculate SRS
        const srs = this.calculateSRS(card, rating);
        card.interval = srs.interval;
        card.easeFactor = srs.easeFactor;
        card.masteryLevel = srs.masteryLevel;
        card.lastReviewedAt = Date.now();
        card.nextReviewAt = Date.now() + srs.interval * 86400000;
        card.reviewCount = (card.reviewCount || 0) + 1;

        await this.db.updateHighlight(card);

        // Next card
        session.index++;
        session.revealed = false;
        this.showReviewCard();
        this.updateReviewBadge();
    }

    showReviewSummary() {
        const session = this.reviewSession;
        if (!session) return;

        const total = session.cards.length;
        const r = session.results;

        const view = document.getElementById('view-review');
        view.innerHTML = `
            <div class="review-summary">
                <h2>🎉 Review Complete!</h2>
                <div class="summary-stats">
                    <div class="summary-stat">
                        <div class="value">${total}</div>
                        <div class="label">Cards Reviewed</div>
                    </div>
                    <div class="summary-stat">
                        <div class="value" style="color:var(--danger)">${r.again}</div>
                        <div class="label">Again</div>
                    </div>
                    <div class="summary-stat">
                        <div class="value" style="color:var(--warning)">${r.hard}</div>
                        <div class="label">Hard</div>
                    </div>
                    <div class="summary-stat">
                        <div class="value" style="color:var(--success)">${r.good}</div>
                        <div class="label">Good</div>
                    </div>
                    <div class="summary-stat">
                        <div class="value" style="color:var(--accent)">${r.easy}</div>
                        <div class="label">Easy</div>
                    </div>
                </div>
                <div style="margin-bottom:16px;">
                    <button class="btn btn-primary btn-lg" id="summary-again">Review More</button>
                </div>
                <button class="btn btn-secondary" id="summary-dashboard">Back to Dashboard</button>
            </div>
        `;

        this.reviewSession = null;

        document.getElementById('summary-again').addEventListener('click', () => this.renderReviewSetup());
        document.getElementById('summary-dashboard').addEventListener('click', () => this.navigate('dashboard'));
    }

    // ============================
    //       EXPORT / IMPORT
    // ============================

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
            if (!confirm(`Import ${data.sources.length} sources and ${data.highlights.length} highlights? This will replace all existing data.`)) {
                return;
            }
            const result = await this.db.importAll(data);
            this.showToast(`Imported ${result.sources} sources, ${result.highlights} highlights!`, 'success');
            this.navigate(this.currentView);
            this.updateReviewBadge();
        } catch (e) {
            this.showToast('Import failed: ' + e.message, 'error');
        }
    }
}

// === Bootstrap ===
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
