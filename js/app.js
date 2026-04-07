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
        this.reviewFilters = this.getDefaultReviewFilters();
        this.backupState = {
            storageSupported: typeof navigator !== 'undefined' && !!navigator.storage,
            persistSupported: typeof navigator !== 'undefined' && !!navigator.storage?.persist,
            persisted: false,
            usage: 0,
            quota: 0,
            fsAccessSupported: typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function',
            fileSaveSupported: typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function',
            folderHandle: null,
            folderName: '',
            folderPermission: 'prompt',
            autoSaveEnabled: localStorage.getItem('langlens-backup-auto-save') === 'true',
            autoSaveOptOut: localStorage.getItem('langlens-backup-auto-save-opt-out') === 'true',
            backupThresholdMs: typeof BackupUtils !== 'undefined' ? BackupUtils.DEFAULT_BACKUP_THRESHOLD_MS : 7 * 24 * 60 * 60 * 1000,
            lastBackupAt: Number(localStorage.getItem('langlens-last-backup-at')) || 0,
            lastBackupMethod: localStorage.getItem('langlens-last-backup-method') || '',
            lastSyncWriteFileName: localStorage.getItem('langlens-last-sync-write-file-name') || '',
            lastSyncWriteAt: Number(localStorage.getItem('langlens-last-sync-write-at')) || 0,
            lastRestoreFileName: localStorage.getItem('langlens-last-restore-file-name') || '',
            lastRestoreAt: Number(localStorage.getItem('langlens-last-restore-at')) || 0,
            lastRestoreSource: localStorage.getItem('langlens-last-restore-source') || ''
        };
        this._pendingSelection = null;
        this._selectionHandler = null;
        this._toastTimer = null;
        this._autoBackupTimer = null;
        this._autoBackupInFlight = false;
        this._autoBackupQueued = false;
        this._pendingAutoBackupReason = '';
        this._libraryCardClickTimer = null;
        this._readerJumpTimer = null;
        this._readerJumpTarget = null;
        this.migrationNotice = null;
    }

    async init() {
        await this.db.init();
        this.loadTheme();
        this.bindEvents();
        await this.restoreBackupPreferences();
        await this.restoreMigrationNotice();
        await this.refreshBackupState();
        const initialRoute = this.parseRoute();
        await this.navigate(initialRoute.view, {
            ...initialRoute,
            replaceHistory: true
        });
        await this.updateReviewBadge();
    }

    loadTheme() {
        const saved = localStorage.getItem('langlens-theme') || 'light';
        document.documentElement.setAttribute('data-theme', saved);
        this.updateThemeButton(saved);
    }

    toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        const next = current === 'light' ? 'dark' : 'light';
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

    formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = bytes;
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex++;
        }
        return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
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

    isCjkChar(char) {
        return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(char || '');
    }

    shouldSkipPdfSpacing(previousText, nextText) {
        const prevChar = previousText.slice(-1);
        const nextChar = nextText.charAt(0);

        if (!prevChar || !nextChar) return true;
        if (/\s/.test(prevChar) || /\s/.test(nextChar)) return true;
        if (this.isCjkChar(prevChar) || this.isCjkChar(nextChar)) return true;
        if (/[([{/'"“‘]/.test(prevChar)) return true;
        if (/[)\]},.!?:;%/'"”’、。！？：；]/.test(nextChar)) return true;

        return false;
    }

    getPdfItemMetrics(item) {
        const rawText = typeof item?.str === 'string' ? item.str.replace(/\u00a0/g, ' ') : '';
        const text = rawText.trim();
        const transform = Array.isArray(item?.transform) ? item.transform : [];
        const x = Number(transform[4]) || 0;
        const y = Number(transform[5]) || 0;
        const width = Math.abs(Number(item?.width)) || 0;
        const height = Math.abs(Number(item?.height)) || Math.abs(Number(transform[3])) || 0;

        return {
            text,
            x,
            y,
            width,
            height,
            endX: x + width,
            avgCharWidth: text ? Math.max(width / text.length, 1) : Math.max(width, 1),
            hasEOL: !!item?.hasEOL
        };
    }

    getPdfBreakCount(previous, current) {
        const lineHeight = Math.max(previous.height, current.height, 1);
        const yDelta = Math.abs(current.y - previous.y);

        if (previous.hasEOL) {
            return yDelta > lineHeight * 1.6 ? 2 : 1;
        }

        if (yDelta <= lineHeight * 0.55) {
            return 0;
        }

        return yDelta > lineHeight * 1.6 ? 2 : 1;
    }

    shouldInsertPdfSpace(previous, current) {
        if (this.shouldSkipPdfSpacing(previous.text, current.text)) {
            return false;
        }

        const gapX = current.x - previous.endX;
        const threshold = Math.max(previous.avgCharWidth, current.avgCharWidth, 1) * 0.3;
        return gapX > threshold;
    }

    extractPdfPageText(textContent) {
        const items = Array.isArray(textContent?.items)
            ? textContent.items.map(item => this.getPdfItemMetrics(item)).filter(item => item.text)
            : [];

        if (items.length === 0) {
            return '';
        }

        let text = items[0].text;

        for (let i = 1; i < items.length; i++) {
            const previous = items[i - 1];
            const current = items[i];
            const breakCount = this.getPdfBreakCount(previous, current);

            if (breakCount > 0) {
                text = text.replace(/[ \t]+$/, '');
                text += '\n'.repeat(breakCount);
            } else if (this.shouldInsertPdfSpace(previous, current)) {
                text += ' ';
            }

            text += current.text;
        }

        return text
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n[ \t]+/g, '\n')
            .replace(/([A-Za-z])\-\n([A-Za-z])/g, '$1$2')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    getUniqueCategories(items) {
        return [...new Set(items.map(item => (item.category || 'General').trim()).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b));
    }

    getDefaultReviewFilters() {
        return {
            categories: [],
            sources: [],
            masteryLevels: []
        };
    }

    cloneReviewFilters(filters = this.reviewFilters) {
        return {
            categories: [...(filters?.categories || [])],
            sources: [...(filters?.sources || [])],
            masteryLevels: [...(filters?.masteryLevels || [])]
        };
    }

    getReviewPrimaryCategory() {
        return this.reviewFilters?.categories?.[0] || '';
    }

    getReviewSourceKey(item = {}) {
        return Number.isFinite(item?.sourceId) ? String(item.sourceId) : 'manual';
    }

    getReviewSourceOptions(items, sourceMap = {}) {
        const options = [];
        const seen = new Set();

        items.forEach(item => {
            const value = this.getReviewSourceKey(item);
            if (seen.has(value)) return;

            seen.add(value);
            const sourceId = Number.parseInt(value, 10);
            options.push({
                value,
                label: value === 'manual'
                    ? 'Manual Items'
                    : (sourceMap[sourceId]?.title || `Text ${value}`)
            });
        });

        return options.sort((left, right) => {
            if (left.value === 'manual') return 1;
            if (right.value === 'manual') return -1;
            return left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
        });
    }

    hasActiveReviewFilters(filters = this.reviewFilters) {
        return (filters?.categories?.length || 0) > 0
            || (filters?.sources?.length || 0) > 0
            || (filters?.masteryLevels?.length || 0) > 0;
    }

    countReviewFilters(filters = this.reviewFilters) {
        return (filters?.categories?.length || 0)
            + (filters?.sources?.length || 0)
            + (filters?.masteryLevels?.length || 0);
    }

    describeReviewFilters(filters = this.reviewFilters) {
        const parts = [];

        if ((filters?.categories?.length || 0) > 0) {
            parts.push(`${filters.categories.length} categor${filters.categories.length === 1 ? 'y' : 'ies'}`);
        }
        if ((filters?.sources?.length || 0) > 0) {
            parts.push(`${filters.sources.length} text${filters.sources.length === 1 ? '' : 's'}`);
        }
        if ((filters?.masteryLevels?.length || 0) > 0) {
            parts.push(`${filters.masteryLevels.length} level${filters.masteryLevels.length === 1 ? '' : 's'}`);
        }

        return parts.length > 0
            ? `Filtering by ${parts.join(' · ')}.`
            : 'Combine categories, source texts, and learning level.';
    }

    itemMatchesReviewFilters(item, filters = this.reviewFilters) {
        const category = (item.category || 'General').trim() || 'General';
        const sourceKey = this.getReviewSourceKey(item);
        const masteryLevel = Number.isFinite(item.masteryLevel) ? item.masteryLevel : 0;

        if ((filters?.categories?.length || 0) > 0 && !filters.categories.includes(category)) {
            return false;
        }

        if ((filters?.sources?.length || 0) > 0 && !filters.sources.includes(sourceKey)) {
            return false;
        }

        if ((filters?.masteryLevels?.length || 0) > 0 && !filters.masteryLevels.includes(masteryLevel)) {
            return false;
        }

        return true;
    }

    filterReviewItems(items, filters = this.reviewFilters) {
        return items.filter(item => this.itemMatchesReviewFilters(item, filters));
    }

    toggleReviewFilter(group, rawValue) {
        if (!this.reviewFilters[group]) return;

        const value = group === 'masteryLevels'
            ? Number.parseInt(rawValue, 10)
            : rawValue;

        if (group === 'masteryLevels' && !Number.isFinite(value)) {
            return;
        }

        if (this.reviewFilters[group].includes(value)) {
            this.reviewFilters[group] = this.reviewFilters[group].filter(entry => entry !== value);
            return;
        }

        this.reviewFilters[group] = [...this.reviewFilters[group], value];
    }

    renderReviewFilterChips(options, selectedValues, group, allLabel) {
        const selected = new Set((selectedValues || []).map(value => String(value)));
        const chips = [
            `<button type="button" class="category-chip review-filter-chip review-filter-chip-all ${selected.size === 0 ? 'active' : ''}" data-review-filter-group="${group}" data-review-filter-value="__all__" aria-pressed="${selected.size === 0 ? 'true' : 'false'}">${this.esc(allLabel)}</button>`
        ];

        options.forEach(option => {
            const value = String(option.value);
            const isActive = selected.has(value);
            chips.push(`
                <button type="button" class="category-chip review-filter-chip ${isActive ? 'active' : ''}" data-review-filter-group="${group}" data-review-filter-value="${this.esc(value)}" aria-pressed="${isActive ? 'true' : 'false'}" title="${this.esc(option.label)}">${this.esc(option.label)}</button>
            `);
        });

        return chips.join('');
    }

    getSourceLabel(item, sourceMap = {}) {
        if (!item.sourceId) return 'Manual';
        const source = sourceMap[item.sourceId];
        return source ? source.title : 'Source';
    }

    getReadingNoteColors() {
        return [
            { value: 'yellow', label: 'Yellow', tone: 'warning', icon: '🟡' },
            { value: 'blue', label: 'Blue', tone: 'accent', icon: '🔵' },
            { value: 'green', label: 'Green', tone: 'success', icon: '🟢' },
            { value: 'red', label: 'Red', tone: 'danger', icon: '🔴' }
        ];
    }

    getReadingNoteColorMeta(color = 'yellow') {
        return this.getReadingNoteColors().find(entry => entry.value === color) || this.getReadingNoteColors()[0];
    }

    renderReadingNoteColorChips(selectedColor = 'yellow') {
        return this.getReadingNoteColors().map(({ value, label, tone, icon }) => `
            <button type="button" class="category-chip ${value === selectedColor ? 'active' : ''}" data-color="${value}" style="border-color:var(--${tone});color:var(--${tone});">${icon} ${label}</button>
        `).join('');
    }

    bindReadingNoteColorChips(formSelector) {
        const chips = [...document.querySelectorAll(`${formSelector} .category-chip[data-color]`)];
        chips.forEach(chip => {
            chip.addEventListener('click', () => {
                chips.forEach(node => node.classList.remove('active'));
                chip.classList.add('active');
            });
        });
    }

    async getReadingNote(noteId, sourceId = null) {
        if (!Number.isFinite(noteId)) return null;

        const notes = Number.isFinite(sourceId)
            ? await this.db.getReadingNotesBySource(sourceId)
            : await this.db.getAllReadingNotes();

        return notes.find(note => note.id === noteId) || null;
    }

    getRouteState(viewName = this.currentView, options = {}) {
        const state = { view: viewName || 'dashboard' };
        const sourceId = Number.parseInt(options.sourceId ?? this.currentSource?.id, 10);
        if (state.view === 'reader' && Number.isFinite(sourceId)) {
            state.sourceId = sourceId;
        }
        return state;
    }

    routeForState(state = {}) {
        if (state.view === 'reader' && Number.isFinite(state.sourceId)) {
            return `#reader/${state.sourceId}`;
        }
        return `#${state.view || 'dashboard'}`;
    }

    parseRoute() {
        const hash = (window.location.hash || '').replace(/^#\/?/, '');
        if (!hash) {
            return { view: 'dashboard' };
        }

        const [view, rawSourceId] = hash.split('/');
        if (view === 'reader') {
            const sourceId = Number.parseInt(rawSourceId, 10);
            if (Number.isFinite(sourceId)) {
                return { view, sourceId };
            }
            return { view: 'library' };
        }

        if (['dashboard', 'library', 'vocab', 'notes', 'review'].includes(view)) {
            return { view };
        }

        return { view: 'dashboard' };
    }

    syncHistoryState(state, { replace = false } = {}) {
        if (!window.history?.pushState) return;

        const route = this.routeForState(state);
        const currentState = window.history.state || {};
        if (window.location.hash === route && currentState.view === state.view && currentState.sourceId === state.sourceId) {
            return;
        }

        const method = replace ? 'replaceState' : 'pushState';
        window.history[method](state, '', route);
    }

    bindEvents() {
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                this.navigate(link.dataset.view);
            });
        });

        window.addEventListener('popstate', (e) => {
            const state = e.state?.view ? e.state : this.parseRoute();
            this.navigate(state.view, {
                ...state,
                updateHistory: false,
                silentMissingSource: true
            }).catch(err => {
                console.error('Failed to restore navigation state:', err);
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
        document.getElementById('btn-export').addEventListener('click', () => this.showBackupCenter());
        document.getElementById('btn-import').addEventListener('click', () => {
            document.getElementById('import-file').click();
        });
        document.getElementById('btn-clear-data')?.addEventListener('click', () => this.showClearDataModal());
        document.getElementById('import-file').addEventListener('change', (e) => {
            if (e.target.files[0]) this.importData(e.target.files[0]);
            e.target.value = '';
        });
    }

    hideSelectionToolbar() {
        document.getElementById('selection-toolbar').classList.add('hidden');
        this._pendingSelection = null;
    }

    async navigate(viewName, options = {}) {
        const allowedViews = new Set(['dashboard', 'library', 'reader', 'vocab', 'notes', 'review']);
        const targetView = allowedViews.has(viewName) ? viewName : 'dashboard';
        let routeState = this.getRouteState(targetView, options);

        if (targetView === 'reader') {
            const sourceId = Number.parseInt(routeState.sourceId, 10);
            if (!Number.isFinite(sourceId)) {
                return this.navigate('library', {
                    updateHistory: options.updateHistory,
                    replaceHistory: options.replaceHistory,
                    silentMissingSource: options.silentMissingSource
                });
            }

            const source = await this.db.getSource(sourceId);
            if (!source) {
                if (!options.silentMissingSource) {
                    this.showToast('Source not found', 'error');
                }
                return this.navigate('library', {
                    updateHistory: options.updateHistory,
                    replaceHistory: options.replaceHistory,
                    silentMissingSource: true
                });
            }

            this.currentSource = source;
            routeState = this.getRouteState(targetView, { sourceId: source.id });
        }

        this.currentView = targetView;

        document.querySelectorAll('.nav-link').forEach(link => link.classList.remove('active'));
        const active = document.querySelector(`.nav-link[data-view="${targetView === 'reader' ? 'library' : targetView}"]`);
        if (active) active.classList.add('active');

        document.querySelectorAll('.view').forEach(view => {
            view.classList.remove('active');
            view.classList.add('hidden');
        });
        const view = document.getElementById(`view-${targetView}`);
        if (view) {
            view.classList.remove('hidden');
            view.classList.add('active');
        }

        if (targetView !== 'reader' && this._selectionHandler) {
            document.removeEventListener('mouseup', this._selectionHandler);
            this._selectionHandler = null;
        }

        if (options.updateHistory !== false) {
            this.syncHistoryState(routeState, { replace: !!options.replaceHistory });
        }

        try {
            if (targetView === 'dashboard') await this.renderDashboard();
            if (targetView === 'library') await this.renderLibrary();
            if (targetView === 'reader') await this.renderReader();
            if (targetView === 'vocab') await this.renderVocab();
            if (targetView === 'notes') await this.renderNotes();
            if (targetView === 'review') await this.renderReviewSetup();
        } catch (err) {
            console.error(`Failed to render ${targetView}:`, err);
            this.showToast(`Unable to open ${targetView}`, 'error');
        }

        document.getElementById('main').scrollTop = 0;
    }

    showModal(html, opts = {}) {
        const overlay = document.getElementById('modal-overlay');
        const content = document.getElementById('modal-content');
        content.innerHTML = html;
        content.className = `modal-content ${opts.size || ''}`;
        overlay.classList.remove('hidden');
    }

    bindEnterToSubmit(form) {
        if (!form) return;

        form.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) {
                return;
            }

            const target = e.target;
            if (!(target instanceof HTMLElement) || !target.matches('input, textarea')) {
                return;
            }

            e.preventDefault();

            if (typeof form.requestSubmit === 'function') {
                form.requestSubmit();
                return;
            }

            const submitButton = form.querySelector('[type="submit"]');
            if (submitButton instanceof HTMLElement) {
                submitButton.click();
            }
        });
    }

    closeModal() {
        document.getElementById('modal-overlay').classList.add('hidden');
    }

    bindSourceImageFallback(scope = document) {
        if (!scope?.querySelectorAll) return;

        scope.querySelectorAll('img[data-source-image]').forEach(img => {
            img.addEventListener('error', () => {
                img.closest('[data-source-image-shell]')?.remove();
            }, { once: true });
        });
    }

    isImageFile(file) {
        if (!file) return false;
        if (String(file.type || '').startsWith('image/')) return true;
        return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name || '');
    }

    readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('Unable to read image file'));
            reader.readAsDataURL(file);
        });
    }

    updateSourceImagePreview(imageUrl) {
        const preview = document.getElementById('src-image-preview');
        if (!preview) return;

        const normalized = String(imageUrl || '').trim();
        if (!normalized) {
            preview.innerHTML = '';
            preview.classList.add('hidden');
            return;
        }

        preview.innerHTML = `
            <div class="source-modal-image-preview" data-source-image-shell>
                <img src="${this.esc(normalized)}" alt="Article image preview" data-source-image>
            </div>
        `;
        preview.classList.remove('hidden');
        this.bindSourceImageFallback(preview);
    }

    bindSourceImageControls() {
        const imageInput = document.getElementById('src-image');
        const imageUpload = document.getElementById('src-image-upload');

        imageInput?.addEventListener('input', () => {
            this.updateSourceImagePreview(imageInput.value);
        });

        imageUpload?.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            if (!this.isImageFile(file)) {
                this.showToast('Choose an image file for the article image.', 'error');
                e.target.value = '';
                return;
            }

            try {
                const imageUrl = await this.readFileAsDataUrl(file);
                if (imageInput) {
                    imageInput.value = imageUrl;
                }
                this.updateSourceImagePreview(imageUrl);
            } catch (err) {
                this.showToast(err.message, 'error');
            } finally {
                e.target.value = '';
            }
        });

        this.updateSourceImagePreview(imageInput?.value || '');
    }

    detectImportedImageUrl(rawUrl) {
        const value = String(rawUrl || '').trim();
        if (!value) return '';
        if (/^(https?:)?\/\//i.test(value) || /^data:image\//i.test(value) || /^blob:/i.test(value)) {
            return value;
        }
        return '';
    }

    extractSourceImageFromDocument(doc) {
        const image = doc.querySelector('img[src]');
        if (!image) return '';
        return this.detectImportedImageUrl(image.getAttribute('src'));
    }

    async extractSourceDataFromFile(file) {
        const name = file.name.toLowerCase();
        const ext = name.substring(name.lastIndexOf('.'));

        if (ext === '.txt' || ext === '.md' || ext === '.csv' || ext === '.srt' || ext === '.vtt') {
            return {
                content: await file.text(),
                imageUrl: ''
            };
        }

        if (ext === '.html' || ext === '.htm' || ext === '.xml') {
            const raw = await file.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(raw, ext === '.xml' ? 'text/xml' : 'text/html');
            const imageUrl = this.extractSourceImageFromDocument(doc);
            doc.querySelectorAll('script, style, noscript').forEach(el => el.remove());

            return {
                content: (doc.body || doc.documentElement).textContent.replace(/\n{3,}/g, '\n\n').trim(),
                imageUrl
            };
        }

        if (ext === '.json') {
            const raw = await file.text();
            try {
                const data = JSON.parse(raw);
                return {
                    content: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
                    imageUrl: ''
                };
            } catch {
                return {
                    content: raw,
                    imageUrl: ''
                };
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
                const pageText = this.extractPdfPageText(textContent);
                if (pageText.trim()) pages.push(pageText.trim());
            }

            if (pages.length === 0) {
                throw new Error('No text content found in PDF');
            }

            return {
                content: pages.join('\n\n'),
                imageUrl: ''
            };
        }

        throw new Error(`Unsupported file type: ${ext}`);
    }

    bindSourceFileUpload() {
        document.getElementById('src-file-upload')?.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const status = document.getElementById('src-file-status');
            const titleInput = document.getElementById('src-title');
            const contentInput = document.getElementById('src-content');
            const imageInput = document.getElementById('src-image');

            status.textContent = 'Extracting text...';
            status.style.color = 'var(--accent)';

            try {
                const sourceData = await this.extractSourceDataFromFile(file);
                contentInput.value = sourceData.content;

                if (!titleInput.value.trim()) {
                    titleInput.value = file.name.replace(/\.[^.]+$/, '');
                }

                if (sourceData.imageUrl && imageInput && !imageInput.value.trim()) {
                    imageInput.value = sourceData.imageUrl;
                    this.updateSourceImagePreview(sourceData.imageUrl);
                }

                status.textContent = sourceData.imageUrl
                    ? `✅ Extracted ${sourceData.content.length} characters from ${file.name} and found an article image`
                    : `✅ Extracted ${sourceData.content.length} characters from ${file.name}`;
                status.style.color = 'var(--success)';
            } catch (err) {
                status.textContent = `❌ Failed: ${err.message}`;
                status.style.color = 'var(--danger)';
            }
        });
    }

    sourceTitleFromText(text = '') {
        const trimmed = String(text || '').trim();
        if (!trimmed) return 'Untitled Text';
        const firstLine = trimmed.split(/\r?\n/).find(line => line.trim()) || trimmed;
        return firstLine.trim().slice(0, 72);
    }

    buildSourceDraft(source = {}) {
        return {
            title: String(source.title || '').trim() || this.sourceTitleFromText(source.content || ''),
            content: String(source.content || ''),
            imageUrl: String(source.imageUrl || '').trim(),
            sourceType: source.sourceType || 'article',
            language: String(source.language || '').trim() || 'Japanese',
            tags: Array.isArray(source.tags) ? source.tags.filter(Boolean) : []
        };
    }

    async saveSource(source, opts = {}) {
        const draft = this.buildSourceDraft(source);
        if (!draft.title || !draft.content.trim()) {
            throw new Error('A title and article content are required.');
        }

        await this.db.addSource(draft);

        if (opts.closeModal) {
            this.closeModal();
        }

        if (opts.toastMessage !== false) {
            this.showToast(opts.toastMessage || 'Text added to library!', 'success');
        }

        this.scheduleAutoBackup(opts.backupReason || 'source add');

        if (this.currentView === 'library') await this.renderLibrary();
        if (this.currentView === 'dashboard') await this.renderDashboard();
        if (this.currentView === 'vocab') await this.renderVocab();
    }

    async importDroppedSources(dataTransfer) {
        const files = Array.from(dataTransfer?.files || []);
        const sourceFiles = files.filter(file => !this.isImageFile(file));
        const imageFiles = files.filter(file => this.isImageFile(file));

        if (sourceFiles.length > 0) {
            const pairedImageUrls = [];

            if (imageFiles.length === sourceFiles.length || (sourceFiles.length === 1 && imageFiles.length === 1)) {
                for (const file of imageFiles) {
                    pairedImageUrls.push(await this.readFileAsDataUrl(file));
                }
            }

            for (const [index, file] of sourceFiles.entries()) {
                const sourceData = await this.extractSourceDataFromFile(file);
                const imageUrl = sourceData.imageUrl || pairedImageUrls[index] || (sourceFiles.length === 1 ? pairedImageUrls[0] : '') || '';
                await this.saveSource({
                    title: file.name.replace(/\.[^.]+$/, ''),
                    content: sourceData.content,
                    imageUrl,
                    sourceType: 'article',
                    language: 'Japanese'
                }, {
                    toastMessage: false,
                    backupReason: 'source drop import'
                });
            }

            return { addedCount: sourceFiles.length, mode: 'files' };
        }

        const droppedText = String(dataTransfer?.getData('text/plain') || '').trim();
        if (droppedText) {
            this.showAddSourceModal({
                title: this.sourceTitleFromText(droppedText),
                content: droppedText,
                sourceType: 'article'
            });
            return { addedCount: 0, mode: 'text' };
        }

        return { addedCount: 0, mode: 'unsupported' };
    }

    bindSourceDropzone(dropzone) {
        if (!dropzone) return;

        const setDragging = (active) => {
            dropzone.classList.toggle('is-dragover', !!active);
        };

        ['dragenter', 'dragover'].forEach(eventName => {
            dropzone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                setDragging(true);
            });
        });

        ['dragleave', 'dragend'].forEach(eventName => {
            dropzone.addEventListener(eventName, () => setDragging(false));
        });

        dropzone.addEventListener('drop', async (e) => {
            e.preventDefault();
            setDragging(false);

            try {
                const result = await this.importDroppedSources(e.dataTransfer);
                if (result.mode === 'files') {
                    this.showToast(`${result.addedCount} text${result.addedCount === 1 ? '' : 's'} added to the library.`, 'success');
                } else if (result.mode === 'text') {
                    this.showToast('Dropped text loaded. Review it and save when ready.', 'success');
                } else {
                    this.showToast('Drop a supported text file, PDF, HTML file, or plain text.', 'error');
                }
            } catch (err) {
                this.showToast(`Drop import failed: ${err.message}`, 'error');
            }
        });
    }

    bindLibraryDropzone(view) {
        this.bindSourceDropzone(view.querySelector('#library-dropzone'));
    }

    bindDashboardDropzone(view) {
        this.bindSourceDropzone(view.querySelector('#dashboard-dropzone'));
    }

    buildRecentActivity(sources, items, readingNotes, sourceMap = {}) {
        const activities = [];

        for (const source of sources) {
            activities.push({
                type: 'source',
                id: source.id,
                sourceId: source.id,
                ts: source.createdAt || 0,
                icon: '📚',
                label: 'Added text',
                title: source.title,
                subtitle: [source.sourceType, source.language].filter(Boolean).join(' · ')
            });
        }

        for (const item of items) {
            activities.push({
                type: 'highlight',
                id: item.id,
                sourceId: item.sourceId || '',
                ts: item.createdAt || 0,
                icon: '📝',
                label: 'Saved item',
                title: item.text,
                subtitle: [item.category || 'General', this.getSourceLabel(item, sourceMap)].filter(Boolean).join(' · ')
            });
        }

        for (const note of readingNotes) {
            const sourceLabel = note.sourceId ? (sourceMap[note.sourceId]?.title || 'Text') : 'Text';
            activities.push({
                type: 'reading-note',
                id: note.id,
                sourceId: note.sourceId || '',
                ts: note.createdAt || 0,
                icon: '📌',
                label: 'Added note',
                title: note.note || note.text,
                subtitle: sourceLabel
            });
        }

        return activities.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 10);
    }

    async openActivity(activity) {
        if (activity.type === 'source') {
            await this.openReader(activity.sourceId);
            return;
        }

        if (activity.type === 'highlight') {
            await this.showHighlightDetailModal(activity.id);
            return;
        }

        if (activity.type === 'reading-note') {
            if (this.currentSource?.id !== activity.sourceId) {
                await this.navigate('reader', { sourceId: activity.sourceId });
            }
            await this.showReadingNoteDetail(activity.id, activity.sourceId);
        }
    }

    async deleteSourceWithConfirm(sourceId) {
        const source = await this.db.getSource(sourceId);
        if (!source) return false;
        if (!confirm(`Delete "${source.title}" and all its saved items and notes?`)) return false;

        await this.db.deleteSource(source.id);

        if (this.currentSource?.id === source.id) {
            this.currentSource = null;
        }

        this.reviewSession = null;
        this.closeModal();
        this.showToast('Text removed from library', 'success');
        this.scheduleAutoBackup('source delete');

        if (this.currentView === 'reader') {
            await this.navigate('library', { replaceHistory: true, silentMissingSource: true });
        } else if (this.currentView === 'library') {
            await this.renderLibrary();
        } else if (this.currentView === 'dashboard') {
            await this.renderDashboard();
        } else if (this.currentView === 'vocab') {
            await this.renderVocab();
        } else if (this.currentView === 'notes') {
            await this.renderNotes();
        } else if (this.currentView === 'review') {
            await this.renderReviewSetup();
        }

        await this.updateReviewBadge();
        return true;
    }

    async deleteHighlightWithConfirm(hlId, opts = {}) {
        const item = opts.item || await this.db.getHighlight(hlId);
        if (!item) return false;
        if (!confirm(opts.message || 'Delete this item?')) return false;

        await this.db.deleteHighlight(item.id);

        if (opts.closeModal) {
            this.closeModal();
        }

        this.showToast('Item deleted', 'success');
        this.scheduleAutoBackup('item delete');

        if (this.currentView === 'reader') {
            await this.renderReader();
        }
        if (this.currentView === 'vocab') {
            await this.renderVocab();
        }
        if (this.currentView === 'dashboard') {
            await this.renderDashboard();
        }
        if (this.currentView === 'review') {
            this.reviewSession = null;
            await this.renderReviewSetup();
        }

        await this.updateReviewBadge();
        return true;
    }

    async deleteReadingNoteWithConfirm(noteId, opts = {}) {
        const note = opts.note || await this.getReadingNote(noteId, opts.sourceId);
        if (!note) return false;
        if (!confirm(opts.message || 'Delete this reading note?')) return false;

        await this.db.deleteReadingNote(note.id);

        if (opts.closeModal) {
            this.closeModal();
        }

        this.showToast('Note deleted', 'success');
        this.scheduleAutoBackup('reading note delete');

        if (this.currentView === 'reader') {
            await this.renderReader();
        }
        if (this.currentView === 'notes') {
            await this.renderNotes();
        }
        if (this.currentView === 'dashboard') {
            await this.renderDashboard();
        }

        return true;
    }

    async showClearDataModal() {
        const [stats, readingNotes] = await Promise.all([
            this.db.getStats(),
            this.db.getAllReadingNotes()
        ]);
        const noteCount = readingNotes.length;
        const hasData = stats.totalSources > 0 || stats.totalHighlights > 0 || noteCount > 0;

        this.showModal(`
            <h3>⚠️ Clear Current Data</h3>
            <div class="detail-stack">
                <div>This removes all texts, saved study items, and reading notes from this browser.</div>
                <div style="margin-top:8px;">Theme settings, backup preferences, and your restore tools stay available so you can start fresh or restore right after.</div>
            </div>
            <div class="backup-summary-grid">
                <div class="backup-summary-card">
                    <div class="value">${stats.totalSources}</div>
                    <div class="label">Texts</div>
                </div>
                <div class="backup-summary-card">
                    <div class="value">${stats.totalHighlights}</div>
                    <div class="label">Items</div>
                </div>
                <div class="backup-summary-card">
                    <div class="value">${noteCount}</div>
                    <div class="label">Notes</div>
                </div>
            </div>
            <label class="backup-checkbox ${hasData ? '' : 'is-disabled'}">
                <input type="checkbox" id="clear-data-confirm" ${hasData ? '' : 'disabled'}>
                <span>I understand this clears the current library on this browser and can only be undone with a backup restore.</span>
            </label>
            <div class="form-actions">
                <button type="button" class="btn btn-secondary" id="clear-data-cancel">Cancel</button>
                <button type="button" class="btn btn-danger" id="clear-data-apply" disabled>${hasData ? 'Clear Data' : 'Nothing to Clear'}</button>
            </div>
        `);

        const confirmInput = document.getElementById('clear-data-confirm');
        const applyButton = document.getElementById('clear-data-apply');

        document.getElementById('clear-data-cancel')?.addEventListener('click', () => this.closeModal());
        confirmInput?.addEventListener('change', () => {
            applyButton.disabled = !confirmInput.checked;
        });
        applyButton?.addEventListener('click', async () => {
            if (!hasData || !confirmInput?.checked) return;

            this.clearAutoBackupTimer();
            this.hideSelectionToolbar();
            await this.db.clearLibraryData();

            this.currentSource = null;
            this.reviewSession = null;
            this.closeModal();
            this.showToast('Current data cleared. Restore remains available.', 'success');

            const targetView = this.currentView === 'reader' ? 'library' : this.currentView;
            await this.navigate(targetView, { replaceHistory: true, silentMissingSource: true });
            await this.updateReviewBadge();
        });
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

    backupMethodLabel(method) {
        return {
            download: 'downloaded plain JSON',
            'download-encrypted': 'downloaded encrypted backup',
            folder: 'saved plain JSON to folder',
            'folder-encrypted': 'saved encrypted backup to folder',
            'folder-auto': 'auto-saved rolling encrypted backup',
            'save-prompt': 'saved plain JSON via prompt',
            'save-prompt-encrypted': 'saved encrypted backup via prompt'
        }[method] || 'saved';
    }

    async loadBackupIntoRestoreFlow(data, options = {}) {
        if (BackupUtils.isEncryptedBackup(data)) {
            await this.showEncryptedRestoreModal(data, options);
            return;
        }

        if (!Array.isArray(data?.sources) || !Array.isArray(data?.highlights)) {
            throw new Error('Invalid backup format');
        }

        await this.showRestoreConfirmModal(data, {
            fileName: options.fileName,
            encrypted: false,
            restoreSource: options.restoreSource || 'manual-file'
        });
    }

    hasAutoBackupTarget() {
        return !!this.backupState.folderHandle && this.backupState.folderPermission === 'granted';
    }

    persistAutoSavePreference() {
        localStorage.setItem('langlens-backup-auto-save', String(!!this.backupState.autoSaveEnabled));
        localStorage.setItem('langlens-backup-auto-save-opt-out', String(!!this.backupState.autoSaveOptOut));
    }

    setAutoBackupEnabled(enabled, options = {}) {
        this.backupState.autoSaveEnabled = !!enabled;

        if (options.rememberOptOut) {
            this.backupState.autoSaveOptOut = !enabled;
        } else if (enabled) {
            this.backupState.autoSaveOptOut = false;
        }

        if (!enabled) {
            this.clearAutoBackupTimer();
        }

        this.persistAutoSavePreference();
        this.updateBackupFooter();
    }

    maybeArmAutoBackup() {
        if (this.backupState.autoSaveOptOut || !this.hasAutoBackupTarget()) {
            return false;
        }

        if (this.backupState.autoSaveEnabled) {
            return true;
        }

        this.setAutoBackupEnabled(true);
        return true;
    }

    clearAutoBackupTimer() {
        if (this._autoBackupTimer) {
            clearTimeout(this._autoBackupTimer);
            this._autoBackupTimer = null;
        }
        this._autoBackupQueued = false;
        this._pendingAutoBackupReason = '';
    }

    stringifyBackupFile(backup) {
        return typeof backup === 'string'
            ? JSON.stringify(backup)
            : JSON.stringify(backup, null, 2);
    }

    restoreSourceLabel(source) {
        return source === 'sync-folder' ? 'sync folder' : 'selected file';
    }

    describeFileActivity(fileName, timestamp, emptyLabel) {
        const normalized = String(fileName || '').trim();
        if (!normalized) {
            return emptyLabel;
        }

        return timestamp
            ? `${normalized} (${this.relativeTime(timestamp)})`
            : normalized;
    }

    describeLastRestoreActivity() {
        if (!this.backupState.lastRestoreFileName) {
            return 'No backup restored yet';
        }

        const detail = this.describeFileActivity(
            this.backupState.lastRestoreFileName,
            this.backupState.lastRestoreAt,
            'No backup restored yet'
        );

        return `${detail} via ${this.restoreSourceLabel(this.backupState.lastRestoreSource)}`;
    }

    describeRecentBackupFileLine() {
        const hasSyncWrite = !!this.backupState.lastSyncWriteFileName;
        const hasRestore = !!this.backupState.lastRestoreFileName;

        if (!hasSyncWrite && !hasRestore) {
            return 'Recent backup file: none yet';
        }

        const syncWriteAt = this.backupState.lastSyncWriteAt || 0;
        const restoreAt = this.backupState.lastRestoreAt || 0;

        if (hasRestore && (!hasSyncWrite || restoreAt >= syncWriteAt)) {
            const age = restoreAt ? ` ${this.relativeTime(restoreAt)}` : '';
            return `Recent backup file: restored ${this.backupState.lastRestoreFileName} from ${this.restoreSourceLabel(this.backupState.lastRestoreSource)}${age}`;
        }

        const age = syncWriteAt ? ` ${this.relativeTime(syncWriteAt)}` : '';
        return `Recent backup file: wrote ${this.backupState.lastSyncWriteFileName}${age}`;
    }

    recordSyncFolderWrite(fileName) {
        const normalized = String(fileName || '').trim();
        if (!normalized) return;

        this.backupState.lastSyncWriteFileName = normalized;
        this.backupState.lastSyncWriteAt = Date.now();
        localStorage.setItem('langlens-last-sync-write-file-name', normalized);
        localStorage.setItem('langlens-last-sync-write-at', String(this.backupState.lastSyncWriteAt));
    }

    recordRestoreFile(fileName, source = 'manual-file') {
        const normalized = String(fileName || '').trim();
        if (!normalized) return;

        this.backupState.lastRestoreFileName = normalized;
        this.backupState.lastRestoreAt = Date.now();
        this.backupState.lastRestoreSource = source || 'manual-file';
        localStorage.setItem('langlens-last-restore-file-name', normalized);
        localStorage.setItem('langlens-last-restore-at', String(this.backupState.lastRestoreAt));
        localStorage.setItem('langlens-last-restore-source', this.backupState.lastRestoreSource);
    }

    updateBackupFooter() {
        const node = document.getElementById('backup-footer-status');
        if (!node) return;

        const storageLine = this.backupState.persistSupported
            ? (this.backupState.persisted ? 'Persistent storage enabled' : 'Persistent storage not granted')
            : 'Persistent storage unavailable';
        const backupLine = this.backupState.lastBackupAt
            ? `Last backup ${this.relativeTime(this.backupState.lastBackupAt)} via ${this.backupMethodLabel(this.backupState.lastBackupMethod)}`
            : 'No backup saved yet';
        const folderLine = this.backupState.folderHandle
            ? `Sync folder: ${this.backupState.folderName || 'selected folder'} (${this.backupState.folderPermission})`
            : 'Sync folder not configured';
        const autoLine = this.backupState.autoSaveEnabled && this.hasAutoBackupTarget()
            ? `Auto-backup on: rewrites ${this.getBackupFileName({ encrypted: true, latest: true })} in the sync folder`
            : 'Auto-backup off';
        const fileLine = this.describeRecentBackupFileLine();

        node.innerHTML = `<div>${this.esc(storageLine)}</div><div>${this.esc(backupLine)}</div><div>${this.esc(folderLine)}</div><div>${this.esc(autoLine)}</div><div>${this.esc(fileLine)}</div>`;
    }

    async refreshBackupState() {
        const storage = typeof navigator !== 'undefined' ? navigator.storage : null;
        this.backupState.storageSupported = !!storage;
        this.backupState.persistSupported = !!storage?.persist;

        if (storage?.persisted) {
            try {
                this.backupState.persisted = await storage.persisted();
            } catch {
                this.backupState.persisted = false;
            }
        }

        if (storage?.estimate) {
            try {
                const estimate = await storage.estimate();
                this.backupState.usage = estimate.usage || 0;
                this.backupState.quota = estimate.quota || 0;
            } catch {
                this.backupState.usage = 0;
                this.backupState.quota = 0;
            }
        }

        if (this.backupState.folderHandle) {
            this.backupState.folderPermission = await this.getFolderPermission(this.backupState.folderHandle, false);
            if (this.backupState.folderPermission !== 'granted') {
                this.backupState.autoSaveEnabled = false;
                this.clearAutoBackupTimer();
                this.persistAutoSavePreference();
            }
        }

        this.updateBackupFooter();
        return this.backupState;
    }

    async restoreBackupPreferences() {
        const thresholdDays = await this.db.getSetting('backup-reminder-days');
        if (Number.isFinite(thresholdDays) && thresholdDays > 0) {
            this.backupState.backupThresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
        }

        if (!this.backupState.fsAccessSupported) return;

        try {
            const handle = await this.db.getSetting('backup-folder-handle');
            if (!handle) return;

            this.backupState.folderHandle = handle;
            this.backupState.folderName = handle.name || 'selected folder';
            this.backupState.folderPermission = await this.getFolderPermission(handle, false);
            if (this.backupState.folderPermission !== 'granted') {
                this.backupState.autoSaveEnabled = false;
                this.clearAutoBackupTimer();
                this.persistAutoSavePreference();
            }
        } catch {
            this.backupState.folderHandle = null;
            this.backupState.folderName = '';
            this.backupState.folderPermission = 'prompt';
            this.backupState.autoSaveEnabled = false;
            this.clearAutoBackupTimer();
            this.persistAutoSavePreference();
        }
    }

    async restoreMigrationNotice() {
        try {
            this.migrationNotice = await this.db.getSetting('migration-notice');
        } catch {
            this.migrationNotice = null;
        }
    }

    backupThresholdDays() {
        return Math.max(1, Math.round(this.backupState.backupThresholdMs / (24 * 60 * 60 * 1000)));
    }

    async setBackupThresholdDays(days) {
        const normalizedDays = Math.max(1, Number.parseInt(days, 10) || 7);
        this.backupState.backupThresholdMs = normalizedDays * 24 * 60 * 60 * 1000;
        await this.db.setSetting('backup-reminder-days', normalizedDays);
    }

    async dismissMigrationNotice() {
        await this.db.deleteSetting('migration-notice');
        this.migrationNotice = null;
        if (this.currentView === 'dashboard') {
            await this.renderDashboard();
        }
    }

    async getFolderPermission(handle, prompt = false) {
        if (!handle) return 'denied';

        try {
            if (typeof handle.queryPermission === 'function') {
                const descriptor = { mode: 'readwrite' };
                let permission = await handle.queryPermission(descriptor);
                if (permission !== 'granted' && prompt && typeof handle.requestPermission === 'function') {
                    permission = await handle.requestPermission(descriptor);
                }
                return permission;
            }
            return 'granted';
        } catch {
            return 'denied';
        }
    }

    async setBackupFolderHandle(handle) {
        if (!handle) {
            await this.clearBackupFolderHandle();
            return;
        }

        await this.db.setSetting('backup-folder-handle', handle);
        this.backupState.folderHandle = handle;
        this.backupState.folderName = handle.name || 'selected folder';
        this.backupState.folderPermission = await this.getFolderPermission(handle, false);
        this.updateBackupFooter();
    }

    async clearBackupFolderHandle() {
        try {
            await this.db.deleteSetting('backup-folder-handle');
        } catch {
            // Ignore cleanup failures and reset local state anyway.
        }

        this.clearAutoBackupTimer();
        this.backupState.folderHandle = null;
        this.backupState.folderName = '';
        this.backupState.folderPermission = 'prompt';
        this.backupState.autoSaveEnabled = false;
        this.persistAutoSavePreference();
        this.updateBackupFooter();
    }

    recordBackupEvent(method, options = {}) {
        this.backupState.lastBackupAt = Date.now();
        this.backupState.lastBackupMethod = method;
        localStorage.setItem('langlens-last-backup-at', String(this.backupState.lastBackupAt));
        localStorage.setItem('langlens-last-backup-method', method);

        if (String(method).startsWith('folder') && options.fileName) {
            this.recordSyncFolderWrite(options.fileName);
        }

        this.updateBackupFooter();
    }

    async getRestoreCandidateFromFolder(handle) {
        if (!handle || typeof handle.entries !== 'function') {
            return null;
        }

        const candidates = [];
        for await (const [name, entry] of handle.entries()) {
            if (entry?.kind !== 'file' || !BackupUtils.isBackupFileName(name)) {
                continue;
            }

            try {
                const file = await entry.getFile();
                candidates.push({
                    name,
                    handle: entry,
                    lastModified: Number(file.lastModified) || 0
                });
            } catch {
                // Ignore files that cannot be read and keep scanning the folder.
            }
        }

        return BackupUtils.pickPreferredBackupFile(candidates);
    }

    async restoreFromBackupFolder() {
        if (!this.backupState.fsAccessSupported) {
            throw new Error('Sync-folder restore requires a Chromium-based browser');
        }

        if (!this.backupState.folderHandle) {
            throw new Error('Choose a sync folder first');
        }

        this.backupState.folderPermission = await this.getFolderPermission(this.backupState.folderHandle, true);
        if (this.backupState.folderPermission !== 'granted') {
            this.updateBackupFooter();
            throw new Error('Allow access to the sync folder before restoring');
        }

        const candidate = await this.getRestoreCandidateFromFolder(this.backupState.folderHandle);
        if (!candidate?.handle) {
            throw new Error('No LangLens backup files were found in the selected sync folder');
        }

        const file = await candidate.handle.getFile();
        const text = await file.text();
        const data = JSON.parse(text);
        await this.loadBackupIntoRestoreFlow(data, {
            fileName: candidate.name,
            restoreSource: 'sync-folder'
        });
    }

    getBackupFileName({ encrypted = false, latest = false } = {}) {
        if (latest) {
            return `langlens-latest-backup${encrypted ? '-encrypted' : ''}.json`;
        }

        const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\.\d+Z$/, 'Z').replace('T', '_');
        return `langlens-backup-${stamp}${encrypted ? '-encrypted' : ''}.json`;
    }

    downloadText(text, fileName) {
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.click();
        URL.revokeObjectURL(url);
    }

    backupSummary(data = {}) {
        return BackupUtils.backupSummary(data);
    }

    async encryptBackupData(data, passphrase) {
        return BackupUtils.encryptBackupData(data, passphrase);
    }

    async decryptBackupData(data, passphrase) {
        return BackupUtils.decryptBackupData(data, passphrase);
    }

    async createBackupPackage(options = {}) {
        const payload = await this.db.exportAll();
        const encrypted = options.encrypted !== false;
        if (encrypted) {
            return this.encryptBackupData(payload, options.passphrase || '');
        }
        return payload;
    }

    async ensureBackupFolder() {
        if (!this.backupState.fsAccessSupported) {
            throw new Error('Folder backups require a Chromium-based browser');
        }

        if (this.backupState.folderHandle) {
            this.backupState.folderPermission = await this.getFolderPermission(this.backupState.folderHandle, true);
            if (this.backupState.folderPermission === 'granted') {
                this.updateBackupFooter();
                return this.backupState.folderHandle;
            }
        }

        try {
            const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
            if (!handle) return null;

            await this.setBackupFolderHandle(handle);
            this.backupState.folderPermission = await this.getFolderPermission(handle, true);
            this.updateBackupFooter();
            return this.backupState.folderPermission === 'granted' ? handle : null;
        } catch (err) {
            if (err?.name === 'AbortError') return null;
            throw err;
        }
    }

    async writeBackupToFolder(options = {}) {
        const handle = options.promptForDirectory === false
            ? (await this.getFolderPermission(this.backupState.folderHandle, false)) === 'granted' ? this.backupState.folderHandle : null
            : await this.ensureBackupFolder();
        if (!handle) return false;

        const encrypted = options.encrypted !== false;
        const backup = await this.createBackupPackage({
            encrypted,
            passphrase: options.passphrase || ''
        });
        const fileName = this.getBackupFileName({
            encrypted,
            latest: !!options.useLatestName
        });
        const fileHandle = await handle.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(this.stringifyBackupFile(backup));
        await writable.close();

        this.recordBackupEvent(encrypted ? (options.auto ? 'folder-auto' : 'folder-encrypted') : 'folder', {
            fileName
        });
        if (!options.quiet) {
            this.maybeArmAutoBackup();
        }
        if (!options.quiet) {
            this.showToast(`Backup saved to sync folder as ${fileName}`, 'success');
        }
        return true;
    }

    async writeBackupWithSavePicker(options = {}) {
        if (!this.backupState.fileSaveSupported) {
            throw new Error('Save prompts are not supported in this browser');
        }

        try {
            const encrypted = options.encrypted !== false;
            const backup = await this.createBackupPackage({
                encrypted,
                passphrase: options.passphrase || ''
            });
            const fileName = this.getBackupFileName({
                encrypted,
                latest: !!options.useLatestName
            });
            const fileHandle = await window.showSaveFilePicker({
                suggestedName: fileName,
                types: [{
                    description: 'LangLens backup',
                    accept: { 'application/json': ['.json'] }
                }]
            });
            const writable = await fileHandle.createWritable();
            await writable.write(this.stringifyBackupFile(backup));
            await writable.close();

            this.recordBackupEvent(encrypted ? 'save-prompt-encrypted' : 'save-prompt');
            if (!options.quiet) {
                this.showToast(`Backup saved as ${fileName}`, 'success');
            }
            return true;
        } catch (err) {
            if (err?.name === 'AbortError') return false;
            throw err;
        }
    }

    async createLatestBackupNow() {
        await this.refreshBackupState();

        if (this.backupState.folderHandle && await this.getFolderPermission(this.backupState.folderHandle, false) === 'granted') {
            await this.writeBackupToFolder({ encrypted: true, useLatestName: true, promptForDirectory: false });
            return;
        }

        await this.exportData({ encrypted: true, useLatestName: true });
    }

    async promptToEnableAutoBackupAfterRestore() {
        if (this.backupState.autoSaveOptOut || this.backupState.autoSaveEnabled || this.hasAutoBackupTarget() || !this.backupState.fsAccessSupported) {
            return false;
        }

        const shouldConfigure = confirm('Restore complete. Choose a sync folder now so future changes can be auto-backed up into one rolling encrypted file?');
        if (!shouldConfigure) {
            return false;
        }

        const handle = await this.ensureBackupFolder();
        if (!handle) {
            return false;
        }

        this.setAutoBackupEnabled(true);
        await this.writeBackupToFolder({
            encrypted: true,
            quiet: true,
            useLatestName: true,
            promptForDirectory: false,
            auto: true
        });
        return true;
    }

    async flushAutoBackup(reason = 'data change') {
        if (!this.backupState.autoSaveEnabled || !this.hasAutoBackupTarget()) {
            return false;
        }

        if (this._autoBackupInFlight) {
            this._autoBackupQueued = true;
            this._pendingAutoBackupReason = reason;
            return false;
        }

        this._autoBackupInFlight = true;

        try {
            const saved = await this.writeBackupToFolder({
                encrypted: true,
                quiet: true,
                useLatestName: true,
                promptForDirectory: false,
                auto: true
            });

            if (!saved) {
                throw new Error('Choose a writable sync folder to resume auto-backup');
            }

            return true;
        } catch (err) {
            this.backupState.autoSaveEnabled = false;
            this.persistAutoSavePreference();
            this.updateBackupFooter();
            this.clearAutoBackupTimer();
            this.showToast(`Auto-backup paused after ${reason}: ${err.message}`, 'error');
            return false;
        } finally {
            this._autoBackupInFlight = false;

            if (this._autoBackupQueued && this.backupState.autoSaveEnabled && this.hasAutoBackupTarget()) {
                const queuedReason = this._pendingAutoBackupReason || reason;
                this._autoBackupQueued = false;
                this._pendingAutoBackupReason = '';
                this.scheduleAutoBackup(queuedReason);
            } else {
                this._autoBackupQueued = false;
                this._pendingAutoBackupReason = '';
            }
        }
    }

    scheduleAutoBackup(reason = 'data change') {
        if (!this.backupState.autoSaveEnabled || !this.hasAutoBackupTarget()) return;
        this.clearAutoBackupTimer();
        this._pendingAutoBackupReason = reason;
        this._autoBackupTimer = setTimeout(() => {
            this._autoBackupTimer = null;
            const pendingReason = this._pendingAutoBackupReason || reason;
            this._pendingAutoBackupReason = '';
            this.flushAutoBackup(pendingReason);
        }, 1200);
    }

    async requestPersistentStorage() {
        if (!navigator.storage?.persist) {
            throw new Error('Persistent storage is not supported in this browser');
        }

        const granted = await navigator.storage.persist();
        await this.refreshBackupState();
        if (!granted) {
            throw new Error('Persistent storage was not granted');
        }
        return true;
    }

    describeImportResult(result) {
        if (result.mode === 'merge') {
            const changedSources = result.sources.added + result.sources.updated;
            const changedHighlights = result.highlights.added + result.highlights.updated;
            const changedNotes = result.readingNotes.added + result.readingNotes.updated;
            const skipped = result.sources.skipped + result.highlights.skipped + result.readingNotes.skipped;
            return `Merge complete: ${changedSources} texts, ${changedHighlights} items, ${changedNotes} notes added or refreshed${skipped > 0 ? `; ${skipped} duplicates skipped` : ''}.`;
        }

        return `Restore complete: ${result.sources.added} texts, ${result.highlights.added} items, ${result.readingNotes.added} notes loaded.`;
    }

    async applyImportedBackup(data, mode, options = {}) {
        const result = await this.db.importAll(data, { mode });
        this.currentSource = null;
        this.reviewSession = null;
        this.closeModal();
        await this.refreshBackupState();
        await this.updateReviewBadge();
        await this.navigate('dashboard');

        let autoBackupReady = this.maybeArmAutoBackup();
        if (!autoBackupReady) {
            autoBackupReady = await this.promptToEnableAutoBackupAfterRestore();
        }
        if (autoBackupReady) {
            this.scheduleAutoBackup('restore');
        }

        this.recordRestoreFile(options.fileName, options.restoreSource);
        this.showToast(this.describeImportResult(result), 'success');
    }

    async showRestoreConfirmModal(data, opts = {}) {
        const summary = this.backupSummary(data);
        this.showModal(`
            <h3>Restore Backup</h3>
            <div class="backup-grid">
                <div class="detail-stack">
                    <div class="backup-panel-title">Backup File</div>
                    <div class="backup-info-list">
                        <div class="backup-info-row"><span>File</span><strong>${this.esc(opts.fileName || 'backup.json')}</strong></div>
                        <div class="backup-info-row"><span>Exported</span><strong>${this.formatDateTime(summary.exportedAt)}</strong></div>
                        <div class="backup-info-row"><span>Schema</span><strong>DB v${summary.schemaVersion || '—'}</strong></div>
                        <div class="backup-info-row"><span>Type</span><strong>${opts.encrypted ? 'Encrypted backup' : 'Plain JSON backup'}</strong></div>
                    </div>
                </div>
                <div class="detail-stack">
                    <div class="backup-panel-title">Backup Contents</div>
                    <div class="backup-summary-grid">
                        <div class="backup-summary-card"><div class="value">${summary.counts.sources}</div><div class="label">Texts</div></div>
                        <div class="backup-summary-card"><div class="value">${summary.counts.highlights}</div><div class="label">Items</div></div>
                        <div class="backup-summary-card"><div class="value">${summary.counts.readingNotes}</div><div class="label">Notes</div></div>
                    </div>
                </div>
            </div>
            <div class="form-group">
                <label>Restore Mode</label>
                <div class="backup-radio-group">
                    <label class="backup-radio-option">
                        <input type="radio" name="restore-mode" value="replace" checked>
                        <span class="backup-radio-copy"><strong>Replace current library</strong><span>Best for full recovery on a new browser or device. Current local data will be overwritten.</span></span>
                    </label>
                    <label class="backup-radio-option">
                        <input type="radio" name="restore-mode" value="merge">
                        <span class="backup-radio-copy"><strong>Merge missing items</strong><span>Best for combining libraries. Matching records stay in place and new ones are added.</span></span>
                    </label>
                </div>
            </div>
            <div class="form-actions">
                <button type="button" class="btn btn-secondary" id="restore-cancel">Cancel</button>
                <button type="button" class="btn btn-primary" id="restore-confirm">⬆ Restore Backup</button>
            </div>
        `, { size: 'modal-lg' });

        document.getElementById('restore-cancel').addEventListener('click', () => this.closeModal());
        document.getElementById('restore-confirm').addEventListener('click', async () => {
            try {
                const mode = document.querySelector('input[name="restore-mode"]:checked')?.value || 'replace';
                await this.applyImportedBackup(data, mode, opts);
            } catch (err) {
                this.showToast(`Restore failed: ${err.message}`, 'error');
            }
        });
    }

    async showEncryptedRestoreModal(data, options = {}) {
        const hasPreview = BackupUtils.isLegacyEncryptedBackup(data);
        const summary = hasPreview ? this.backupSummary(data) : null;
        this.showModal(`
            <h3>Unlock Backup</h3>
            <div class="detail-stack">
                <div class="backup-panel-title">Encrypted Backup</div>
                <div class="backup-info-list">
                    <div class="backup-info-row"><span>File</span><strong>${this.esc(options.fileName || 'backup.json')}</strong></div>
                    ${hasPreview
                        ? `<div class="backup-info-row"><span>Exported</span><strong>${this.formatDateTime(summary.exportedAt)}</strong></div>
                    <div class="backup-info-row"><span>Texts / Items / Notes</span><strong>${summary.counts.sources} / ${summary.counts.highlights} / ${summary.counts.readingNotes}</strong></div>`
                        : '<div class="backup-info-row"><span>Preview</span><strong>Hidden until the file is unlocked</strong></div>'}
                </div>
            </div>
            <div class="form-group">
                <label>Passphrase</label>
                <input type="password" id="restore-passphrase" placeholder="Enter the passphrase if you used one">
                <div class="backup-field-hint">If this backup was created without a passphrase, leave this blank. Decryption still happens locally in your browser.</div>
            </div>
            <div class="form-actions">
                <button type="button" class="btn btn-secondary" id="restore-encrypted-cancel">Cancel</button>
                <button type="button" class="btn btn-primary" id="restore-encrypted-confirm">Unlock Backup</button>
            </div>
        `, { size: 'modal-lg' });

        document.getElementById('restore-encrypted-cancel').addEventListener('click', () => this.closeModal());
        document.getElementById('restore-encrypted-confirm').addEventListener('click', async () => {
            try {
                const passphrase = document.getElementById('restore-passphrase').value;
                const decrypted = await this.decryptBackupData(data, passphrase);
                await this.showRestoreConfirmModal(decrypted, {
                    fileName: options.fileName,
                    encrypted: true,
                    restoreSource: options.restoreSource || 'manual-file'
                });
            } catch (err) {
                this.showToast(err.message, 'error');
            }
        });
    }

    async showBackupCenter() {
        await this.refreshBackupState();
        const backup = await this.db.exportAll();
        const summary = this.backupSummary(backup);
        const canPromptForBackupLocation = this.backupState.fsAccessSupported || this.backupState.fileSaveSupported;
        const latestEncryptedFileName = this.getBackupFileName({ encrypted: true, latest: true });
        const quotaLine = this.backupState.quota
            ? `${this.formatBytes(this.backupState.usage)} used of ${this.formatBytes(this.backupState.quota)}`
            : 'Usage estimate unavailable';
        const lastBackupLine = this.backupState.lastBackupAt
            ? `${this.formatDateTime(this.backupState.lastBackupAt)} (${this.relativeTime(this.backupState.lastBackupAt)})`
            : 'No backup saved yet';
        const lastSyncWriteLine = this.describeFileActivity(
            this.backupState.lastSyncWriteFileName,
            this.backupState.lastSyncWriteAt,
            'No sync-folder backup written yet'
        );
        const lastRestoreLine = this.describeLastRestoreActivity();
        const folderLine = this.backupState.folderHandle
            ? `${this.backupState.folderName || 'selected folder'} (${this.backupState.folderPermission})`
            : 'Not configured';
        const thresholdDays = this.backupThresholdDays();

        this.showModal(`
            <h3>Backup & Restore</h3>
            <div class="backup-grid">
                <div class="detail-stack">
                    <div class="backup-panel-title">Local Storage Health</div>
                    <div class="backup-info-list">
                        <div class="backup-info-row"><span>Live data location</span><strong>This browser on this device</strong></div>
                        <div class="backup-info-row"><span>Persistent storage</span><strong>${this.backupState.persistSupported ? (this.backupState.persisted ? 'Enabled' : 'Not granted') : 'Unsupported'}</strong></div>
                        <div class="backup-info-row"><span>Browser estimate</span><strong>${this.esc(quotaLine)}</strong></div>
                        <div class="backup-info-row"><span>Last backup</span><strong>${this.esc(lastBackupLine)}</strong></div>
                        <div class="backup-info-row"><span>Sync folder</span><strong>${this.esc(folderLine)}</strong></div>
                        <div class="backup-info-row"><span>Last sync write</span><strong>${this.esc(lastSyncWriteLine)}</strong></div>
                        <div class="backup-info-row"><span>Last restore file</span><strong>${this.esc(lastRestoreLine)}</strong></div>
                    </div>
                    <div class="backup-inline-actions">
                        <button type="button" class="btn btn-secondary" id="backup-request-persist" ${this.backupState.persisted || !this.backupState.persistSupported ? 'disabled' : ''}>🛡 Request Persistent Storage</button>
                        <button type="button" class="btn btn-secondary" id="backup-restore-folder" ${this.backupState.folderHandle ? '' : 'disabled'}>⬆ Restore From Sync Folder</button>
                        <button type="button" class="btn btn-secondary" id="backup-clear-folder" ${this.backupState.folderHandle ? '' : 'disabled'}>🗑 Forget Sync Folder</button>
                    </div>
                    <div class="backup-field-hint">Persistent storage lowers the chance that the browser evicts IndexedDB data under storage pressure, but it is not a substitute for backups. If you choose a folder inside Google Drive Desktop, OneDrive, Dropbox, or another desktop sync tool, LangLens can treat it as a cloud-backed sync folder.</div>
                </div>
                <div class="detail-stack">
                    <div class="backup-panel-title">Current Library Snapshot</div>
                    <div class="backup-summary-grid">
                        <div class="backup-summary-card"><div class="value">${summary.counts.sources}</div><div class="label">Texts</div></div>
                        <div class="backup-summary-card"><div class="value">${summary.counts.highlights}</div><div class="label">Items</div></div>
                        <div class="backup-summary-card"><div class="value">${summary.counts.readingNotes}</div><div class="label">Notes</div></div>
                    </div>
                    <div class="form-group backup-threshold-group">
                        <label for="backup-threshold-days">Reminder threshold</label>
                        <select id="backup-threshold-days">
                            <option value="1" ${thresholdDays === 1 ? 'selected' : ''}>1 day</option>
                            <option value="3" ${thresholdDays === 3 ? 'selected' : ''}>3 days</option>
                            <option value="7" ${thresholdDays === 7 ? 'selected' : ''}>7 days</option>
                            <option value="14" ${thresholdDays === 14 ? 'selected' : ''}>14 days</option>
                            <option value="30" ${thresholdDays === 30 ? 'selected' : ''}>30 days</option>
                        </select>
                    </div>
                    <div class="backup-field-hint">Use Replace restore for a full recovery on another browser. Use Merge only when you want to combine libraries.</div>
                </div>
            </div>
            <form id="backup-export-form">
                <div class="form-group">
                    <label>Backup Format</label>
                    <div class="backup-radio-group">
                        <label class="backup-radio-option">
                            <input type="radio" name="backup-format" value="encrypted" checked>
                            <span class="backup-radio-copy"><strong>Encrypted JSON</strong><span>Default. The file is sealed even if you leave the passphrase blank.</span></span>
                        </label>
                        <label class="backup-radio-option">
                            <input type="radio" name="backup-format" value="plain">
                            <span class="backup-radio-copy"><strong>Plain JSON</strong><span>Readable without decryption. Use only when you explicitly need an unencrypted export.</span></span>
                        </label>
                    </div>
                </div>
                <div id="backup-passphrase-fields">
                    <div class="form-row">
                        <div class="form-group">
                            <label>Passphrase</label>
                            <input type="password" id="backup-passphrase" placeholder="Optional passphrase">
                        </div>
                        <div class="form-group">
                            <label>Confirm Passphrase</label>
                            <input type="password" id="backup-passphrase-confirm" placeholder="Repeat the passphrase if you set one">
                        </div>
                    </div>
                    <div class="backup-field-hint">Leave the passphrase blank for passwordless encrypted backup files. Add one for stronger protection that only someone with the passphrase can unlock.</div>
                </div>
                <div id="backup-plain-warning" class="detail-stack hidden">
                    <div class="backup-panel-title">Plain JSON Warning</div>
                    <div>Plain JSON backups are readable by anyone who opens the file.</div>
                    <label class="backup-checkbox" style="margin-top:12px;">
                        <input type="checkbox" id="backup-plain-confirm">
                        <span>I understand this backup will be saved without encryption.</span>
                    </label>
                </div>
                <div class="backup-inline-actions">
                    <button type="submit" class="btn btn-primary" id="backup-submit">${canPromptForBackupLocation ? '💾 Save Encrypted Backup' : '⬇ Download Encrypted Backup'}</button>
                    ${this.backupState.fsAccessSupported ? '<button type="button" class="btn btn-secondary" id="backup-select-folder">📁 Choose Sync Folder</button>' : ''}
                </div>
                <div class="backup-field-hint">${canPromptForBackupLocation ? 'Save Backup reuses the remembered sync folder or asks you to choose one before saving.' : 'This browser does not expose a reusable save location, so backups use the normal browser download location.'}</div>
                ${this.backupState.fsAccessSupported ? `
                    <div class="backup-folder-box">
                        <label class="backup-checkbox"><input type="checkbox" id="backup-auto-save" ${this.backupState.autoSaveEnabled ? 'checked' : ''}> Auto-backup encrypted snapshots to the selected folder after changes</label>
                        <div class="backup-field-hint">The first successful folder backup arms this automatically unless you turn it off. Auto-backup rewrites ${latestEncryptedFileName} after changes settle, so it keeps one rolling file instead of creating a new JSON every time. Restoring from the sync folder prefers that rolling latest file, then falls back to the newest timestamped snapshot.</div>
                    </div>
                ` : ''}
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" id="backup-close">Close</button>
                </div>
            </form>
        `, { size: 'modal-lg' });

        const updatePassphraseFields = () => {
            const encrypted = document.querySelector('input[name="backup-format"]:checked')?.value !== 'plain';
            document.getElementById('backup-passphrase-fields').classList.toggle('hidden', !encrypted);
            document.getElementById('backup-plain-warning').classList.toggle('hidden', encrypted);
            const submitButton = document.getElementById('backup-submit');
            if (submitButton) {
                submitButton.textContent = encrypted
                    ? (canPromptForBackupLocation ? '💾 Save Encrypted Backup' : '⬇ Download Encrypted Backup')
                    : (canPromptForBackupLocation ? '💾 Save Plain JSON' : '⬇ Download Plain JSON');
            }
        };

        document.querySelectorAll('input[name="backup-format"]').forEach(input => {
            input.addEventListener('change', updatePassphraseFields);
        });
        updatePassphraseFields();

        document.getElementById('backup-close').addEventListener('click', () => this.closeModal());
        document.getElementById('backup-request-persist')?.addEventListener('click', async () => {
            try {
                await this.requestPersistentStorage();
                this.showToast('Persistent storage enabled', 'success');
                await this.showBackupCenter();
            } catch (err) {
                this.showToast(err.message, 'error');
            }
        });
        document.getElementById('backup-clear-folder')?.addEventListener('click', async () => {
            try {
                await this.clearBackupFolderHandle();
                this.showToast('Saved sync folder was removed', 'success');
                await this.showBackupCenter();
            } catch (err) {
                this.showToast(err.message, 'error');
            }
        });
        document.getElementById('backup-restore-folder')?.addEventListener('click', async () => {
            try {
                await this.restoreFromBackupFolder();
            } catch (err) {
                this.showToast(err.message, 'error');
            }
        });
        document.getElementById('backup-threshold-days')?.addEventListener('change', async (e) => {
            try {
                await this.setBackupThresholdDays(e.target.value);
                this.showToast('Backup reminder threshold updated', 'success');
                if (this.currentView === 'dashboard') {
                    await this.renderDashboard();
                }
            } catch (err) {
                this.showToast(err.message, 'error');
            }
        });

        const getBackupOptions = () => {
            const encrypted = document.querySelector('input[name="backup-format"]:checked')?.value !== 'plain';
            const passphrase = document.getElementById('backup-passphrase')?.value || '';
            const confirmPassphrase = document.getElementById('backup-passphrase-confirm')?.value || '';
            if (encrypted) {
                if ((passphrase || confirmPassphrase) && passphrase !== confirmPassphrase) {
                    throw new Error('Passphrases do not match');
                }
            } else if (!document.getElementById('backup-plain-confirm')?.checked) {
                throw new Error('Confirm the plain JSON warning to continue');
            }
            return { encrypted, passphrase };
        };

        document.getElementById('backup-export-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            try {
                await this.exportData(getBackupOptions());
            } catch (err) {
                this.showToast(err.message, 'error');
            }
        });

        document.getElementById('backup-select-folder')?.addEventListener('click', async () => {
            try {
                const handle = await this.ensureBackupFolder();
                if (!handle) return;
                this.showToast(`Sync folder set to ${this.backupState.folderName || 'selected folder'}`, 'success');
                await this.showBackupCenter();
            } catch (err) {
                this.showToast(err.message, 'error');
            }
        });

        document.getElementById('backup-auto-save')?.addEventListener('change', async (e) => {
            try {
                if (e.target.checked) {
                    const handle = await this.ensureBackupFolder();
                    if (!handle) {
                        e.target.checked = false;
                        return;
                    }
                    this.setAutoBackupEnabled(true, { rememberOptOut: true });
                    await this.writeBackupToFolder({ encrypted: true, quiet: true, useLatestName: true, promptForDirectory: false, auto: true });
                    this.showToast('Auto-backup enabled', 'success');
                } else {
                    this.setAutoBackupEnabled(false, { rememberOptOut: true });
                    this.showToast('Auto-backup disabled');
                }
                await this.showBackupCenter();
            } catch (err) {
                e.target.checked = false;
                this.setAutoBackupEnabled(false);
                this.showToast(err.message, 'error');
            }
        });
    }

    async renderDashboard() {
        const [stats, items, sources, readingNotes] = await Promise.all([
            this.db.getStats(),
            this.db.getAllHighlights(),
            this.db.getAllSources(),
            this.db.getAllReadingNotes()
        ]);
        const sourceMap = {};
        for (const source of sources) sourceMap[source.id] = source;
        const recentActivity = this.buildRecentActivity(sources, items, readingNotes, sourceMap);
        const backupReminder = BackupUtils.getBackupReminder({
            totalSources: stats.totalSources,
            totalHighlights: stats.totalHighlights,
            totalReadingNotes: readingNotes.length,
            lastBackupAt: this.backupState.lastBackupAt,
            thresholdMs: this.backupState.backupThresholdMs
        });
        const reminderMessage = backupReminder.kind === 'stale' && this.backupState.lastBackupAt
            ? `${backupReminder.message} Last backup was ${this.relativeTime(this.backupState.lastBackupAt)}.`
            : backupReminder.message;
        const migrationMessage = this.migrationNotice
            ? `This library was upgraded from DB v${this.migrationNotice.fromVersion} to v${this.migrationNotice.toVersion}. Backup controls and folder recovery support are now available.`
            : '';

        const view = document.getElementById('view-dashboard');
        view.innerHTML = `
            <div class="view-header">
                <h2>Dashboard</h2>
            </div>

            ${this.migrationNotice ? `
                <div class="migration-banner">
                    <div>
                        <div class="migration-banner-title">Backup Protection Added</div>
                        <p>${this.esc(migrationMessage)}</p>
                    </div>
                    <div class="migration-banner-actions">
                        <button class="btn btn-secondary" id="dash-migration-open">Open Backup</button>
                        <button class="btn btn-secondary" id="dash-migration-dismiss">Dismiss</button>
                    </div>
                </div>
            ` : ''}

            ${backupReminder.shouldShow ? `
                <div class="backup-reminder backup-reminder-${backupReminder.kind}">
                    <div>
                        <div class="backup-reminder-title">${this.esc(backupReminder.title)}</div>
                        <p>${this.esc(reminderMessage)}</p>
                    </div>
                    <div class="migration-banner-actions">
                        <button class="btn btn-primary" id="dash-backup-now">Create Backup Now</button>
                        <button class="btn btn-secondary" id="dash-open-backup">Open Backup</button>
                    </div>
                </div>
            ` : ''}

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
                <button class="btn btn-secondary btn-lg" id="dash-review" ${stats.totalHighlights === 0 ? 'disabled' : ''}>🧠 ${stats.dueCount > 0 ? `Review (${stats.dueCount})` : 'Review Items'}</button>
                <button class="btn btn-secondary btn-lg" id="dash-add-source">📚 Add Text</button>
                <button class="btn btn-secondary btn-lg" id="dash-backup">💾 Backup</button>
            </div>

            <div class="library-dropzone dashboard-dropzone" id="dashboard-dropzone">
                <div class="dashboard-dropzone-mark">+</div>
                <div>
                    <div class="dashboard-dropzone-kicker">Quick Import</div>
                    <div class="library-dropzone-title">Drop files or text onto the dashboard</div>
                    <p>Drag a text file, PDF, HTML file, or plain text here to add it fast. Plain text opens the editor first so you can review it before saving.</p>
                </div>
            </div>

            ${recentActivity.length > 0 ? `
                <div class="section-title">Recent Activity</div>
                <div class="recent-list">
                    ${recentActivity.map(activity => `
                        <div class="recent-item" data-activity-type="${activity.type}" data-activity-id="${activity.id}" data-source-id="${activity.sourceId || ''}">
                            <span class="recent-item-icon">${activity.icon}</span>
                            <div class="ri-main">
                                <div class="ri-topline">
                                    <span class="ri-chip">${this.esc(activity.label)}</span>
                                    ${activity.subtitle ? `<span class="ri-subtext">${this.esc(activity.subtitle)}</span>` : ''}
                                </div>
                                <span class="ri-text">${this.esc(activity.title)}</span>
                            </div>
                            <span class="ri-meta">${this.relativeTime(activity.ts)}</span>
                        </div>
                    `).join('')}
                </div>
            ` : `
                <div class="empty-state">
                    <div class="empty-icon">🕘</div>
                    <p>No activity yet. Add a text, save an item, or drop a file into the library to get started.</p>
                </div>
            `}
        `;

        document.getElementById('dash-add-item')?.addEventListener('click', () => {
            this.showQuickAddItemModal({}, { title: 'Add New Item' });
        });
        document.getElementById('dash-migration-open')?.addEventListener('click', () => this.showBackupCenter());
        document.getElementById('dash-migration-dismiss')?.addEventListener('click', () => this.dismissMigrationNotice());
        document.getElementById('dash-backup-now')?.addEventListener('click', () => this.createLatestBackupNow());
        document.getElementById('dash-open-backup')?.addEventListener('click', () => this.showBackupCenter());
        document.getElementById('dash-add-source')?.addEventListener('click', () => this.showAddSourceModal());
        document.getElementById('dash-backup')?.addEventListener('click', () => this.showBackupCenter());
        document.getElementById('dash-review')?.addEventListener('click', async () => {
            await this.navigate('review');
            if (stats.dueCount > 0) {
                await this.startReviewSession();
            }
        });
        this.bindDashboardDropzone(view);
        view.querySelectorAll('.recent-item').forEach(item => {
            item.addEventListener('click', async () => {
                await this.openActivity({
                    type: item.dataset.activityType,
                    id: parseInt(item.dataset.activityId, 10),
                    sourceId: item.dataset.sourceId ? parseInt(item.dataset.sourceId, 10) : null
                });
            });
        });
    }

    async renderLibrary() {
        const [sources, highlights] = await Promise.all([
            this.db.getAllSources(),
            this.db.getAllHighlights()
        ]);
        const counts = {};
        for (const item of highlights) {
            if (item.sourceId) counts[item.sourceId] = (counts[item.sourceId] || 0) + 1;
        }

        const languageSet = new Set();
        const tagSet = new Set();
        for (const source of sources) {
            const language = String(source.language || '').trim();
            if (language) languageSet.add(language);

            for (const tag of Array.isArray(source.tags) ? source.tags : []) {
                const normalizedTag = String(tag || '').trim();
                if (normalizedTag) tagSet.add(normalizedTag);
            }
        }

        const view = document.getElementById('view-library');
        const totalSources = sources.length;
        const languages = [...languageSet].sort((a, b) => a.localeCompare(b));
        const tags = [...tagSet].sort((a, b) => a.localeCompare(b));
        const sourceTypes = [
            { value: 'article', label: 'Article' },
            { value: 'audio', label: 'Audio Transcript' },
            { value: 'video', label: 'Video Subtitle' },
            { value: 'other', label: 'Other' }
        ];

        const renderCards = (visibleSources) => {
            const container = document.getElementById('library-cards-container');
            const countLabel = document.getElementById('lib-count');
            const totalLabel = `${totalSources} text${totalSources === 1 ? '' : 's'}`;

            if (countLabel) {
                countLabel.textContent = visibleSources.length === totalSources
                    ? totalLabel
                    : `${visibleSources.length} of ${totalLabel}`;
            }

            if (visibleSources.length === 0) {
                container.innerHTML = totalSources === 0 ? `
                    <div class="empty-state">
                        <div class="empty-icon">📚</div>
                        <p>Your text library is empty. Add a source if you want to pull study items directly from reading.</p>
                        <button class="btn btn-primary" id="lib-add-empty">➕ Add Your First Text</button>
                    </div>
                ` : `
                    <div class="empty-state">
                        <div class="empty-icon">🗂️</div>
                        <p>No texts match the current filters. Adjust the search or clear the filter bar.</p>
                        <button class="btn btn-secondary" id="lib-clear-filters">Reset Filters</button>
                    </div>
                `;

                document.getElementById('lib-add-empty')?.addEventListener('click', () => this.showAddSourceModal());
                document.getElementById('lib-clear-filters')?.addEventListener('click', () => {
                    document.getElementById('library-search').value = '';
                    document.getElementById('library-filter-type').value = '';
                    document.getElementById('library-filter-language').value = '';
                    document.getElementById('library-filter-tag').value = '';
                    document.getElementById('library-sort').value = 'newest';
                    applyFilters();
                });
                return;
            }

            container.innerHTML = `
                <div class="cards-grid">
                    ${visibleSources.map(source => {
                        const previewText = (source.content || '').substring(0, 200);
                        return `
                        <div class="source-card" data-id="${source.id}">
                            ${source.imageUrl ? `
                                <div class="source-card-image" data-source-image-shell>
                                    <img src="${this.esc(source.imageUrl)}" alt="${this.esc(source.title)}" data-source-image>
                                </div>
                            ` : ''}
                            <div class="card-header">
                                <div class="card-title-stack">
                                    <div class="card-title" title="${this.esc(source.title)}">${this.esc(source.title)}</div>
                                </div>
                                <div class="card-header-side">
                                    <span class="type-badge ${source.sourceType}">${source.sourceType}</span>
                                    <div class="card-actions">
                                        <button type="button" class="icon-action-btn" data-source-action="edit" title="Edit text">✏️</button>
                                        <button type="button" class="icon-action-btn icon-action-danger" data-source-action="delete" title="Remove text">✕</button>
                                    </div>
                                </div>
                            </div>
                            <div class="card-preview" title="${this.esc(previewText)}">${this.esc(previewText)}</div>
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
                    `;
                    }).join('')}
                </div>
            `;

            container.querySelectorAll('.source-card').forEach(card => {
                card.addEventListener('click', (e) => {
                    if (e.target.closest('.icon-action-btn')) return;

                    clearTimeout(this._libraryCardClickTimer);
                    const sourceId = parseInt(card.dataset.id, 10);
                    this._libraryCardClickTimer = setTimeout(() => {
                        this.openReader(sourceId);
                        this._libraryCardClickTimer = null;
                    }, 220);
                });

                card.addEventListener('dblclick', (e) => {
                    if (e.target.closest('.icon-action-btn')) return;

                    clearTimeout(this._libraryCardClickTimer);
                    this._libraryCardClickTimer = null;
                    const sourceId = parseInt(card.dataset.id, 10);
                    const source = visibleSources.find(entry => entry.id === sourceId);
                    if (source) {
                        this.showEditSourceModal({
                            ...source,
                            tags: [...(source.tags || [])]
                        });
                    }
                });
            });

            container.querySelectorAll('.icon-action-btn[data-source-action]').forEach(button => {
                button.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const card = button.closest('.source-card');
                    const sourceId = parseInt(card.dataset.id, 10);
                    const source = visibleSources.find(entry => entry.id === sourceId);
                    if (!source) return;

                    if (button.dataset.sourceAction === 'edit') {
                        this.showEditSourceModal({
                            ...source,
                            tags: [...(source.tags || [])]
                        });
                        return;
                    }

                    await this.deleteSourceWithConfirm(sourceId);
                });
            });

            this.bindSourceImageFallback(container);
        };

        const applyFilters = () => {
            const search = document.getElementById('library-search').value.trim().toLowerCase();
            const type = document.getElementById('library-filter-type').value;
            const language = document.getElementById('library-filter-language').value;
            const tag = document.getElementById('library-filter-tag').value;
            const sort = document.getElementById('library-sort').value;

            let filtered = [...sources];

            if (search) {
                filtered = filtered.filter(source => {
                    const haystack = [
                        source.title || '',
                        source.content || '',
                        source.language || '',
                        source.sourceType || '',
                        ...(Array.isArray(source.tags) ? source.tags : [])
                    ].join(' ').toLowerCase();

                    return haystack.includes(search);
                });
            }

            if (type) filtered = filtered.filter(source => (source.sourceType || 'article') === type);
            if (language) filtered = filtered.filter(source => String(source.language || '').trim() === language);
            if (tag) filtered = filtered.filter(source => Array.isArray(source.tags) && source.tags.includes(tag));

            if (sort === 'newest') filtered.sort((a, b) => b.createdAt - a.createdAt);
            if (sort === 'oldest') filtered.sort((a, b) => a.createdAt - b.createdAt);
            if (sort === 'alpha') {
                filtered.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' }));
            }
            if (sort === 'items-desc') {
                filtered.sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0) || b.createdAt - a.createdAt);
            }

            renderCards(filtered);
        };

        view.innerHTML = `
            <div class="view-header">
                <h2>📚 Library</h2>
                <div class="view-header-actions">
                    <span id="lib-count" style="color:var(--text-secondary);font-size:0.85rem;">${totalSources} texts</span>
                    <button class="btn btn-primary" id="lib-add">➕ Add Text</button>
                </div>
            </div>

            <div class="vocab-filters">
                <input type="text" id="library-search" placeholder="🔍 Search title, text, tags, language...">
                <select id="library-filter-type">
                    <option value="">All Types</option>
                    ${sourceTypes.map(type => `<option value="${type.value}">${this.esc(type.label)}</option>`).join('')}
                </select>
                <select id="library-filter-language">
                    <option value="">All Languages</option>
                    ${languages.map(language => `<option value="${this.esc(language)}">${this.esc(language)}</option>`).join('')}
                </select>
                <select id="library-filter-tag">
                    <option value="">All Tags</option>
                    ${tags.map(tag => `<option value="${this.esc(tag)}">${this.esc(tag)}</option>`).join('')}
                </select>
                <select id="library-sort">
                    <option value="newest">Newest First</option>
                    <option value="oldest">Oldest First</option>
                    <option value="alpha">Title A → Z</option>
                    <option value="items-desc">Most Items</option>
                </select>
            </div>

            <div class="library-dropzone" id="library-dropzone">
                <div class="library-dropzone-title">Drop files or text here</div>
                <p>Drop text files, PDFs, HTML, or pasted text to add them to the library. If you drop one image with one article file, it becomes the article image. Single-click a card to read it, double-click to edit it.</p>
            </div>

            <div id="library-cards-container"></div>
        `;

        document.getElementById('lib-add')?.addEventListener('click', () => this.showAddSourceModal());
        ['library-search', 'library-filter-type', 'library-filter-language', 'library-filter-tag', 'library-sort'].forEach(id => {
            const el = document.getElementById(id);
            el.addEventListener(id === 'library-search' ? 'input' : 'change', applyFilters);
        });
        this.bindLibraryDropzone(view);
        applyFilters();
    }

    showAddSourceModal(initialData = {}) {
        this.showModal(`
            <h3>📝 Add New Text</h3>
            <form id="add-source-form">
                <div class="form-group">
                    <label>Title</label>
                    <input type="text" id="src-title" value="${this.esc(initialData.title || '')}" placeholder="e.g., NHK News Article, Podcast Ep. 42..." required>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Source Type</label>
                        <select id="src-type">
                            <option value="article" ${initialData.sourceType === 'article' || !initialData.sourceType ? 'selected' : ''}>📄 Article</option>
                            <option value="audio" ${initialData.sourceType === 'audio' ? 'selected' : ''}>🎧 Audio Transcript</option>
                            <option value="video" ${initialData.sourceType === 'video' ? 'selected' : ''}>🎬 Video Subtitle</option>
                            <option value="other" ${initialData.sourceType === 'other' ? 'selected' : ''}>📋 Other</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Language</label>
                        <input type="text" id="src-lang" placeholder="e.g., Japanese" value="${this.esc(initialData.language || 'Japanese')}">
                    </div>
                </div>
                <div class="form-group">
                    <label>Tags <span class="form-hint">(comma-separated)</span></label>
                    <input type="text" id="src-tags" value="${this.esc((initialData.tags || []).join(', '))}" placeholder="e.g., N3, news, conversation">
                </div>
                <div class="form-group">
                    <label>Article Image URL <span class="form-hint">optional, shown in the library and reader</span></label>
                    <input type="url" id="src-image" value="${this.esc(initialData.imageUrl || '')}" placeholder="https://example.com/article-image.jpg">
                </div>
                <div class="form-group">
                    <label>Upload Article Image <span class="form-hint">optional image file</span></label>
                    <input type="file" id="src-image-upload" accept="image/*">
                    <div id="src-image-preview" class="hidden"></div>
                </div>
                <div class="form-group">
                    <label>Upload File <span class="form-hint">(.txt, .pdf, .html, .htm, .md)</span></label>
                    <input type="file" id="src-file-upload" accept=".txt,.pdf,.html,.htm,.md,.csv,.xml,.json,.srt,.vtt,.epub">
                    <div id="src-file-status" style="font-size:0.78rem;color:var(--text-muted);margin-top:6px;"></div>
                </div>
                <div class="form-group">
                    <label>Content</label>
                    <textarea id="src-content" rows="10" placeholder="Paste your text content here or upload a file above..." required>${this.esc(initialData.content || '')}</textarea>
                </div>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" id="src-cancel">Cancel</button>
                    <button type="submit" class="btn btn-primary">💾 Save</button>
                </div>
            </form>
        `, { size: 'modal-lg' });

        this.bindSourceFileUpload();
        this.bindSourceImageControls();

        document.getElementById('src-cancel').addEventListener('click', () => this.closeModal());
        document.getElementById('add-source-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const title = document.getElementById('src-title').value.trim();
            const content = document.getElementById('src-content').value;
            if (!title || !content.trim()) return;

            const tags = document.getElementById('src-tags').value
                .split(',')
                .map(tag => tag.trim())
                .filter(Boolean);

            await this.saveSource({
                title,
                content,
                imageUrl: document.getElementById('src-image').value.trim(),
                sourceType: document.getElementById('src-type').value,
                language: document.getElementById('src-lang').value.trim(),
                tags
            }, { closeModal: true, backupReason: 'source add' });
        });
    }

    async extractTextFromFile(file) {
        const sourceData = await this.extractSourceDataFromFile(file);
        return sourceData.content;
    }

    async openReader(sourceId, focus = null) {
        await this.navigate('reader', { sourceId });
        if (focus) {
            this.focusReaderTarget(focus);
        }
    }

    focusReaderTarget(target = {}) {
        if (this.currentView !== 'reader' || !this.currentSource) return false;

        const readerContent = document.getElementById('reader-content');
        if (!readerContent) return false;

        let selector = '';
        if (Number.isFinite(target.highlightId)) {
            selector = `.hl[data-hl-id="${target.highlightId}"]`;
        } else if (Number.isFinite(target.noteId)) {
            selector = `.hl-reading-note[data-note-id="${target.noteId}"]`;
        }

        if (!selector) return false;

        const element = readerContent.querySelector(selector);
        if (!element) return false;

        if (this._readerJumpTimer) {
            clearTimeout(this._readerJumpTimer);
            this._readerJumpTimer = null;
        }

        if (this._readerJumpTarget && this._readerJumpTarget !== element) {
            this._readerJumpTarget.classList.remove('reader-jump-target');
        }

        this._readerJumpTarget = element;
        element.classList.add('reader-jump-target');
        element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });

        this._readerJumpTimer = setTimeout(() => {
            element.classList.remove('reader-jump-target');
            if (this._readerJumpTarget === element) {
                this._readerJumpTarget = null;
            }
        }, 1600);

        return true;
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
                ${source.imageUrl ? `
                    <div class="reader-source-cover" data-source-image-shell>
                        <img src="${this.esc(source.imageUrl)}" alt="${this.esc(source.title)}" data-source-image>
                    </div>
                ` : ''}
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
                        ${items.sort((a, b) => (a.startOffset || 0) - (b.startOffset || 0)).map(item => {
                            const canJump = Number.isFinite(item.startOffset) && Number.isFinite(item.endOffset);
                            return `
                            <div class="hl-list-item" data-hl-id="${item.id}" title="${canJump ? 'Jump to this item in the article' : 'Open item details'}">
                                <div class="hl-text">
                                    <span class="hl-type-dot dot-item"></span>
                                    ${this.esc(item.text)}
                                </div>
                                <div class="hl-meta-line">${this.esc(item.category || 'General')} · ${item.charCount || item.text.length} chars</div>
                                ${item.note ? `<div class="hl-note">${this.esc(item.note)}</div>` : ''}
                            </div>
                        `;
                        }).join('')}
                    </div>
                    ${readingNotes.length > 0 ? `
                        <h3 style="margin-top:20px;">📌 Reading Notes (${readingNotes.length})</h3>
                        <div id="reader-notes-list">
                            ${readingNotes.sort((a, b) => (a.startOffset || 0) - (b.startOffset || 0)).map(note => {
                                const canJump = Number.isFinite(note.startOffset) && Number.isFinite(note.endOffset);
                                return `
                                <div class="hl-list-item reading-note-item" data-note-id="${note.id}" title="${canJump ? 'Jump to this note in the article' : 'Open note details'}">
                                    <div class="hl-text" style="color:var(--${note.color === 'blue' ? 'accent' : note.color === 'green' ? 'success' : note.color === 'red' ? 'danger' : 'warning'});">
                                        📌 ${this.esc(note.text.substring(0, 40))}${note.text.length > 40 ? '…' : ''}
                                    </div>
                                    <div class="hl-note">${this.esc(note.note)}</div>
                                </div>
                            `;
                            }).join('')}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;

        document.getElementById('reader-back').addEventListener('click', () => this.navigate('library'));
        document.getElementById('reader-delete-source')?.addEventListener('click', async () => {
            await this.deleteSourceWithConfirm(source.id);
        });
        document.getElementById('reader-edit-source')?.addEventListener('click', () => this.showEditSourceModal(source));
        view.querySelector('.reader-text-area')?.addEventListener('dblclick', (e) => {
            const targetElement = e.target instanceof Element ? e.target : e.target?.parentElement;
            if (targetElement?.closest('.hl[data-hl-id], .hl-reading-note[data-note-id]')) return;

            this.hideSelectionToolbar();
            window.getSelection()?.removeAllRanges();
            this.showEditSourceModal({
                ...source,
                tags: [...(source.tags || [])]
            });
        });

        view.querySelectorAll('.hl-list-item[data-hl-id]').forEach(item => {
            item.addEventListener('click', async () => {
                const hlId = parseInt(item.dataset.hlId, 10);
                const highlight = items.find(entry => entry.id === hlId);
                if (Number.isFinite(highlight?.startOffset) && Number.isFinite(highlight?.endOffset)) {
                    await this.openReader(source.id, { highlightId: hlId });
                    return;
                }

                this.showHighlightDetailModal(hlId);
            });
        });
        view.querySelectorAll('.hl[data-hl-id]').forEach(span => {
            span.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showHighlightDetailModal(parseInt(span.dataset.hlId, 10));
            });
        });
        view.querySelectorAll('.reading-note-item').forEach(item => {
            item.addEventListener('click', async () => {
                const noteId = parseInt(item.dataset.noteId, 10);
                const note = readingNotes.find(entry => entry.id === noteId);
                if (Number.isFinite(note?.startOffset) && Number.isFinite(note?.endOffset)) {
                    await this.openReader(source.id, { noteId });
                    return;
                }

                this.showReadingNoteDetail(noteId, source.id);
            });
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
        this.bindSourceImageFallback(view);
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
        const suggestedCat = data.category || this.getReviewPrimaryCategory() || this.suggestCategory(data.text || '');
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

        this.bindEnterToSubmit(document.getElementById('item-form'));
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
            this.scheduleAutoBackup('item add');
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
        const canJumpToSource = !!source;
        const canJumpToItem = Number.isFinite(item.startOffset) && Number.isFinite(item.endOffset);

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
                ${canJumpToSource ? '<button class="btn btn-secondary" id="hl-open-source">Open in Reader</button>' : ''}
                <button class="btn btn-danger btn-sm" id="hl-delete">🗑️ Delete</button>
                <button class="btn btn-secondary" id="hl-edit">✏️ Edit</button>
                <button class="btn btn-primary" id="hl-close">Close</button>
            </div>
        `);

        document.getElementById('hl-close').addEventListener('click', () => this.closeModal());
        document.getElementById('hl-open-source')?.addEventListener('click', async () => {
            this.closeModal();
            await this.openReader(source.id, canJumpToItem ? { highlightId: item.id } : null);
        });
        document.getElementById('hl-delete').addEventListener('click', async () => {
            await this.deleteHighlightWithConfirm(hlId, { item, closeModal: true });
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
            this.scheduleAutoBackup('item update');
            if (this.currentView === 'reader') await this.renderReader();
            if (this.currentView === 'vocab') await this.renderVocab();
            if (this.currentView === 'dashboard') await this.renderDashboard();
            this.updateReviewBadge();
        });
    }

    async showEditSourceModal(source) {
        const latestSource = await this.db.getSource(source.id) || source;
        const [items, readingNotes] = await Promise.all([
            this.db.getHighlightsBySource(latestSource.id),
            this.db.getReadingNotesBySource(latestSource.id)
        ]);
        const anchoredItemCount = items.filter(item => Number.isFinite(item.startOffset) && Number.isFinite(item.endOffset)).length;
        const anchoredNoteCount = readingNotes.filter(note => Number.isFinite(note.startOffset) && Number.isFinite(note.endOffset)).length;
        const hasAnchoredAnnotations = anchoredItemCount > 0 || anchoredNoteCount > 0;

        this.showModal(`
            <h3>✏️ Edit Source</h3>
            <form id="edit-source-form">
                <div class="form-group">
                    <label>Title</label>
                    <input type="text" id="src-title" value="${this.esc(latestSource.title)}" required>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Source Type</label>
                        <select id="src-type">
                            <option value="article" ${latestSource.sourceType === 'article' ? 'selected' : ''}>📄 Article</option>
                            <option value="audio" ${latestSource.sourceType === 'audio' ? 'selected' : ''}>🎧 Audio</option>
                            <option value="video" ${latestSource.sourceType === 'video' ? 'selected' : ''}>🎬 Video</option>
                            <option value="other" ${latestSource.sourceType === 'other' ? 'selected' : ''}>📋 Other</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Language</label>
                        <input type="text" id="src-lang" value="${this.esc(latestSource.language || '')}">
                    </div>
                </div>
                <div class="form-group">
                    <label>Tags</label>
                    <input type="text" id="src-tags" value="${this.esc((latestSource.tags || []).join(', '))}">
                </div>
                <div class="form-group">
                    <label>Article Image URL <span class="form-hint">optional, shown in the library and reader</span></label>
                    <input type="url" id="src-image" value="${this.esc(latestSource.imageUrl || '')}" placeholder="https://example.com/article-image.jpg">
                </div>
                <div class="form-group">
                    <label>Upload Article Image <span class="form-hint">optional image file</span></label>
                    <input type="file" id="src-image-upload" accept="image/*">
                    <div id="src-image-preview" class="hidden"></div>
                </div>
                <div class="form-group">
                    <label>Replace From File <span class="form-hint">(.txt, .pdf, .html, .htm, .md)</span></label>
                    <input type="file" id="src-file-upload" accept=".txt,.pdf,.html,.htm,.md,.csv,.xml,.json,.srt,.vtt,.epub">
                    <div id="src-file-status" style="font-size:0.78rem;color:var(--text-muted);margin-top:6px;"></div>
                </div>
                <div class="form-group">
                    <label>Content</label>
                    <textarea id="src-content" rows="12" required>${this.esc(latestSource.content || '')}</textarea>
                </div>
                ${hasAnchoredAnnotations ? `
                    <div class="warning-note">
                        Editing the article body will clear ${anchoredItemCount} inline item position${anchoredItemCount === 1 ? '' : 's'} and ${anchoredNoteCount} note position${anchoredNoteCount === 1 ? '' : 's'} so saved annotations do not drift to the wrong text.
                    </div>
                ` : ''}
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" id="src-cancel">Cancel</button>
                    <button type="submit" class="btn btn-primary">💾 Update</button>
                </div>
            </form>
        `, { size: 'modal-lg' });

        this.bindSourceFileUpload();
        this.bindSourceImageControls();

        document.getElementById('src-cancel').addEventListener('click', () => this.closeModal());
        document.getElementById('edit-source-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const nextTitle = document.getElementById('src-title').value.trim();
            const nextContent = document.getElementById('src-content').value;
            if (!nextTitle || !nextContent.trim()) return;

            const contentChanged = nextContent !== (latestSource.content || '');
            if (contentChanged && hasAnchoredAnnotations) {
                const itemLabel = `${anchoredItemCount} saved item${anchoredItemCount === 1 ? '' : 's'}`;
                const noteLabel = `${anchoredNoteCount} reading note${anchoredNoteCount === 1 ? '' : 's'}`;
                const confirmed = confirm(`Update "${latestSource.title}"? ${itemLabel} and ${noteLabel} will stay in the library, but their inline positions will be cleared so they do not point to the wrong text.`);
                if (!confirmed) return;
            }

            const updatedSource = {
                ...latestSource,
                title: nextTitle,
                sourceType: document.getElementById('src-type').value,
                language: document.getElementById('src-lang').value.trim(),
                imageUrl: document.getElementById('src-image').value.trim(),
                content: nextContent,
                tags: document.getElementById('src-tags').value.split(',').map(tag => tag.trim()).filter(Boolean)
            };

            await this.db.updateSource(updatedSource);
            if (contentChanged && hasAnchoredAnnotations) {
                await this.db.clearSourceAnnotationOffsets(updatedSource.id);
            }

            this.closeModal();
            this.showToast(
                contentChanged && hasAnchoredAnnotations
                    ? 'Text updated. Inline annotations were detached to avoid drift.'
                    : 'Source updated!',
                'success'
            );
            this.scheduleAutoBackup(contentChanged ? 'source content update' : 'source update');

            if (this.currentSource?.id === updatedSource.id) {
                this.currentSource = updatedSource;
            }

            if (this.currentView === 'reader' && this.currentSource?.id === updatedSource.id) {
                await this.renderReader();
            }
            if (this.currentView === 'library') {
                await this.renderLibrary();
            }
            if (this.currentView === 'dashboard') {
                await this.renderDashboard();
            }
            if (this.currentView === 'vocab') {
                await this.renderVocab();
            }
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
                        ${this.renderReadingNoteColorChips(data.color || 'yellow')}
                    </div>
                </div>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" id="rn-cancel">Cancel</button>
                    <button type="submit" class="btn btn-primary">📌 Save Note</button>
                </div>
            </form>
        `);

        this.bindReadingNoteColorChips('#reading-note-form');

        this.bindEnterToSubmit(document.getElementById('reading-note-form'));
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
            this.scheduleAutoBackup('reading note add');
            await this.renderReader();
        });
    }

    async showReadingNoteDetail(noteId, sourceId = this.currentSource?.id) {
        const note = await this.getReadingNote(noteId, sourceId);
        if (!note) return;
        const resolvedSourceId = Number.isFinite(note.sourceId) ? note.sourceId : sourceId;
        const source = Number.isFinite(resolvedSourceId) ? await this.db.getSource(resolvedSourceId) : null;
        const colorMeta = this.getReadingNoteColorMeta(note.color);
        const canJumpToSource = !!source;
        const canJumpToNote = !!source && Number.isFinite(note.startOffset) && Number.isFinite(note.endOffset);

        this.showModal(`
            <h3>📌 Reading Note</h3>
            <div class="selected-text-preview">${this.esc(note.text)}</div>
            <div class="detail-stack">
                <div>${this.esc(note.note)}</div>
                <div><strong>Color:</strong> <span class="tag note-color-tag note-color-${colorMeta.value}">${this.esc(colorMeta.label)}</span></div>
                ${source ? `<div><strong>Source:</strong> ${this.esc(source.title)}</div>` : ''}
                <div style="margin-top:8px;font-size:0.78rem;color:var(--text-muted);">${this.formatDateTime(note.createdAt)}</div>
            </div>
            <div class="form-actions">
                ${canJumpToSource ? '<button class="btn btn-secondary" id="rn-open-source">Open in Reader</button>' : ''}
                <button class="btn btn-danger btn-sm" id="rn-delete">🗑️ Delete</button>
                <button class="btn btn-secondary" id="rn-edit">✏️ Edit</button>
                <button class="btn btn-primary" id="rn-close">Close</button>
            </div>
        `);

        document.getElementById('rn-close').addEventListener('click', () => this.closeModal());
        document.getElementById('rn-open-source')?.addEventListener('click', async () => {
            this.closeModal();
            await this.openReader(source.id, canJumpToNote ? { noteId: note.id } : null);
        });
        document.getElementById('rn-edit')?.addEventListener('click', async () => {
            this.closeModal();
            await this.showEditReadingNoteModal(note, source);
        });
        document.getElementById('rn-delete').addEventListener('click', async () => {
            await this.deleteReadingNoteWithConfirm(note.id, { note, closeModal: true });
        });
    }

    async showEditReadingNoteModal(note, source = null) {
        const linkedSource = source || (Number.isFinite(note.sourceId) ? await this.db.getSource(note.sourceId) : null);

        this.showModal(`
            <h3>✏️ Edit Reading Note</h3>
            <div class="selected-text-preview">${this.esc(note.text)}</div>
            <form id="edit-reading-note-form">
                <div class="form-group">
                    <label>Your Note</label>
                    <textarea id="edit-rn-content" rows="4" placeholder="Write your thought, question, or observation..." required>${this.esc(note.note || '')}</textarea>
                </div>
                <div class="form-group">
                    <label>Color</label>
                    <div class="category-chip-row">
                        ${this.renderReadingNoteColorChips(note.color || 'yellow')}
                    </div>
                </div>
                ${linkedSource ? `
                    <div class="item-meta-panel">
                        <div><strong>Source:</strong> ${this.esc(linkedSource.title)}</div>
                    </div>
                ` : ''}
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" id="edit-rn-cancel">Cancel</button>
                    <button type="submit" class="btn btn-primary">💾 Update</button>
                </div>
            </form>
        `);

        this.bindReadingNoteColorChips('#edit-reading-note-form');
        this.bindEnterToSubmit(document.getElementById('edit-reading-note-form'));
        document.getElementById('edit-rn-cancel').addEventListener('click', () => this.closeModal());
        document.getElementById('edit-reading-note-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const content = document.getElementById('edit-rn-content').value.trim();
            if (!content) return;

            await this.db.updateReadingNote({
                ...note,
                note: content,
                color: document.querySelector('#edit-reading-note-form .category-chip.active')?.dataset.color || note.color || 'yellow'
            });

            this.closeModal();
            this.showToast('Note updated!', 'success');
            this.scheduleAutoBackup('reading note update');

            if (this.currentView === 'reader') {
                await this.renderReader();
            }
            if (this.currentView === 'notes') {
                await this.renderNotes();
            }
            if (this.currentView === 'dashboard') {
                await this.renderDashboard();
            }
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

    async renderNotes() {
        const notes = await this.db.getAllReadingNotes();
        const sources = await this.db.getAllSources();
        const sourceMap = {};
        for (const source of sources) sourceMap[source.id] = source;
        const view = document.getElementById('view-notes');

        view.innerHTML = `
            <div class="view-header">
                <h2>📌 Reading Notes</h2>
                <div class="view-header-actions">
                    <span style="color:var(--text-secondary);font-size:0.85rem;">${notes.length} notes</span>
                    <button class="btn btn-secondary" id="notes-open-library">📚 Open Library</button>
                </div>
            </div>

            <div class="vocab-filters">
                <input type="text" id="notes-search" placeholder="🔍 Search selection, note, source...">
                <select id="notes-filter-color">
                    <option value="">All Colors</option>
                    ${this.getReadingNoteColors().map(color => `<option value="${color.value}">${this.esc(color.label)}</option>`).join('')}
                </select>
                <select id="notes-filter-source">
                    <option value="">All Sources</option>
                    <option value="manual">Manual / Unlinked</option>
                    ${sources.map(source => `<option value="${source.id}">${this.esc(source.title)}</option>`).join('')}
                </select>
                <select id="notes-sort">
                    <option value="newest">Newest First</option>
                    <option value="oldest">Oldest First</option>
                    <option value="alpha">Selected Text A → Z</option>
                    <option value="source">Source A → Z</option>
                </select>
            </div>

            <div id="notes-table-container">${this.renderNotesTable(notes, sourceMap)}</div>
        `;

        const applyFilters = () => {
            const search = document.getElementById('notes-search').value.toLowerCase();
            const color = document.getElementById('notes-filter-color').value;
            const sourceId = document.getElementById('notes-filter-source').value;
            const sort = document.getElementById('notes-sort').value;

            let filtered = [...notes];
            if (search) {
                filtered = filtered.filter(note =>
                    note.text.toLowerCase().includes(search)
                    || (note.note || '').toLowerCase().includes(search)
                    || this.getSourceLabel(note, sourceMap).toLowerCase().includes(search)
                );
            }
            if (color) filtered = filtered.filter(note => (note.color || 'yellow') === color);
            if (sourceId === 'manual') filtered = filtered.filter(note => !note.sourceId);
            if (sourceId && sourceId !== 'manual') filtered = filtered.filter(note => note.sourceId === parseInt(sourceId, 10));

            if (sort === 'newest') filtered.sort((a, b) => b.createdAt - a.createdAt);
            if (sort === 'oldest') filtered.sort((a, b) => a.createdAt - b.createdAt);
            if (sort === 'alpha') filtered.sort((a, b) => a.text.localeCompare(b.text));
            if (sort === 'source') filtered.sort((a, b) => this.getSourceLabel(a, sourceMap).localeCompare(this.getSourceLabel(b, sourceMap)));

            document.getElementById('notes-table-container').innerHTML = this.renderNotesTable(filtered, sourceMap);
            this.bindNotesTableEvents();
        };

        ['notes-search', 'notes-filter-color', 'notes-filter-source', 'notes-sort'].forEach(id => {
            const el = document.getElementById(id);
            el.addEventListener(id === 'notes-search' ? 'input' : 'change', applyFilters);
        });

        document.getElementById('notes-open-library')?.addEventListener('click', () => this.navigate('library'));

        this.bindNotesTableEvents();
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
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${items.map(item => {
                        const level = item.masteryLevel || 0;
                        const textPreview = item.text || '—';
                        const notePreview = item.note || '—';
                        return `
                            <tr class="vocab-row" data-hl-id="${item.id}">
                                <td>
                                    <div class="vocab-text table-preview-line" title="${this.esc(textPreview)}">${this.esc(textPreview)}</div>
                                </td>
                                <td><div class="table-preview-line" title="${this.esc(notePreview)}">${this.esc(notePreview)}</div></td>
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
                                <td class="actions-cell">
                                    <div class="table-actions">
                                        <button type="button" class="icon-action-btn" data-item-action="edit" data-hl-id="${item.id}" title="Edit item">✏️</button>
                                        <button type="button" class="icon-action-btn icon-action-danger" data-item-action="delete" data-hl-id="${item.id}" title="Delete item">✕</button>
                                    </div>
                                </td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        `;
    }

    renderNotesTable(notes, sourceMap) {
        if (notes.length === 0) {
            return '<div class="empty-state"><div class="empty-icon">📌</div><p>No reading notes match your filters.</p></div>';
        }

        return `
            <table class="vocab-table">
                <thead>
                    <tr>
                        <th>Selected Text</th>
                        <th>Note</th>
                        <th>Color</th>
                        <th>Source</th>
                        <th>Added</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${notes.map(note => {
                        const colorMeta = this.getReadingNoteColorMeta(note.color);
                        const sourceId = Number.isFinite(note.sourceId) ? note.sourceId : '';
                        const selectedText = note.text || '—';
                        const notePreview = note.note || '—';
                        return `
                            <tr class="notes-row" data-note-id="${note.id}" data-source-id="${sourceId}">
                                <td>
                                    <div class="vocab-text table-preview-line" style="color:var(--${colorMeta.tone});" title="${this.esc(selectedText)}">${this.esc(selectedText)}</div>
                                </td>
                                <td>
                                    <div class="table-preview-line" title="${this.esc(notePreview)}">${this.esc(notePreview)}</div>
                                </td>
                                <td><span class="tag note-color-tag note-color-${colorMeta.value}">${this.esc(colorMeta.label)}</span></td>
                                <td style="font-size:0.78rem;color:var(--text-secondary);">${this.esc(this.getSourceLabel(note, sourceMap))}</td>
                                <td style="font-size:0.78rem;color:var(--text-muted);white-space:nowrap;">${this.formatDate(note.createdAt)}</td>
                                <td class="actions-cell">
                                    <div class="table-actions">
                                        <button type="button" class="icon-action-btn" data-note-action="edit" data-note-id="${note.id}" data-source-id="${sourceId}" title="Edit note">✏️</button>
                                        <button type="button" class="icon-action-btn icon-action-danger" data-note-action="delete" data-note-id="${note.id}" data-source-id="${sourceId}" title="Delete note">✕</button>
                                    </div>
                                </td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        `;
    }

    bindVocabTableEvents() {
        document.querySelectorAll('.vocab-row').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('.icon-action-btn')) return;
                this.showHighlightDetailModal(parseInt(row.dataset.hlId, 10));
            });
        });

        document.querySelectorAll('.icon-action-btn[data-item-action]').forEach(button => {
            button.addEventListener('click', async (e) => {
                e.stopPropagation();
                const hlId = parseInt(button.dataset.hlId, 10);
                if (button.dataset.itemAction === 'edit') {
                    const item = await this.db.getHighlight(hlId);
                    if (item) {
                        this.showEditHighlightModal(item);
                    }
                    return;
                }

                await this.deleteHighlightWithConfirm(hlId);
            });
        });
    }

    bindNotesTableEvents() {
        document.querySelectorAll('.notes-row').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('.icon-action-btn')) return;
                const noteId = parseInt(row.dataset.noteId, 10);
                const sourceId = parseInt(row.dataset.sourceId, 10);
                this.showReadingNoteDetail(noteId, Number.isFinite(sourceId) ? sourceId : null);
            });
        });

        document.querySelectorAll('.icon-action-btn[data-note-action]').forEach(button => {
            button.addEventListener('click', async (e) => {
                e.stopPropagation();
                const noteId = parseInt(button.dataset.noteId, 10);
                const sourceId = parseInt(button.dataset.sourceId, 10);
                const note = await this.getReadingNote(noteId, Number.isFinite(sourceId) ? sourceId : null);
                if (!note) return;

                if (button.dataset.noteAction === 'edit') {
                    await this.showEditReadingNoteModal(note);
                    return;
                }

                await this.deleteReadingNoteWithConfirm(noteId, {
                    note,
                    sourceId: Number.isFinite(sourceId) ? sourceId : null
                });
            });
        });
    }

    async renderReviewSetup() {
        const [due, allItems, sources] = await Promise.all([
            this.db.getDueHighlights(),
            this.db.getAllHighlights(),
            this.db.getAllSources()
        ]);
        const sourceMap = {};
        sources.forEach(source => {
            sourceMap[source.id] = source;
        });
        const categories = this.getUniqueCategories(allItems);
        const sourceOptions = this.getReviewSourceOptions(allItems, sourceMap);
        const masteryOptions = Array.from({ length: 6 }, (_, level) => ({
            value: String(level),
            label: this.masteryName(level)
        }));

        this.reviewFilters = {
            categories: this.reviewFilters.categories.filter(category => categories.includes(category)),
            sources: this.reviewFilters.sources.filter(sourceId => sourceOptions.some(option => option.value === sourceId)),
            masteryLevels: this.reviewFilters.masteryLevels.filter(level => masteryOptions.some(option => option.value === String(level)))
        };

        const filteredDue = this.filterReviewItems(due, this.reviewFilters);
        const filteredAllItems = this.filterReviewItems(allItems, this.reviewFilters);
        const filteredCount = filteredDue.length;
        const filteredSavedCount = filteredAllItems.length;
        const activeFilterCount = this.countReviewFilters(this.reviewFilters);
        const view = document.getElementById('view-review');

        view.innerHTML = `
            <div class="review-setup">
                <h2>🧠 Review Mode</h2>
                <p class="review-intro">Front shows only the prompt. Flip to reveal your note and details.</p>
                <div class="review-stat">${filteredCount}</div>
                <p class="review-count-note">items ready to review</p>
                <div class="review-filter-panel">
                    <div class="review-filter-panel-header">
                        <div>
                            <div class="review-filter-panel-title">Focus this session</div>
                            <p>${this.esc(this.describeReviewFilters(this.reviewFilters))}</p>
                        </div>
                        ${activeFilterCount > 0 ? '<button class="btn btn-secondary btn-sm" id="review-clear-filters">Clear Filters</button>' : ''}
                    </div>
                    <div class="review-filter-groups">
                        <div class="review-filter-group">
                            <div class="review-filter-label">Categories</div>
                            <div class="review-filter-chip-row">
                                ${this.renderReviewFilterChips(categories.map(category => ({ value: category, label: category })), this.reviewFilters.categories, 'categories', 'All Categories')}
                            </div>
                        </div>
                        <div class="review-filter-group">
                            <div class="review-filter-label">Texts</div>
                            <div class="review-filter-chip-row">
                                ${this.renderReviewFilterChips(sourceOptions, this.reviewFilters.sources, 'sources', 'All Texts')}
                            </div>
                        </div>
                        <div class="review-filter-group">
                            <div class="review-filter-label">Learning Level</div>
                            <div class="review-filter-chip-row">
                                ${this.renderReviewFilterChips(masteryOptions, this.reviewFilters.masteryLevels, 'masteryLevels', 'All Levels')}
                            </div>
                        </div>
                    </div>
                </div>
                ${filteredCount > 0 ? `
                    <button class="btn btn-primary btn-lg" id="review-start-all">Start Review (${filteredCount})</button>
                    <div style="margin-top:16px;">
                        <button class="btn btn-secondary" id="review-start-10">Quick Review (10 items)</button>
                    </div>
                ` : filteredSavedCount > 0 ? `
                    <p class="review-manual-message">No items are due right now in this view. You can still study saved items manually.</p>
                    <button class="btn btn-primary btn-lg" id="review-start-saved">Review Saved Items (${filteredSavedCount})</button>
                    <div style="margin-top:16px;">
                        <button class="btn btn-secondary" id="review-start-saved-10">Quick Review Saved Items (10)</button>
                    </div>
                ` : `
                    <p class="review-empty-message">Nothing is due in this view.</p>
                    <button class="btn btn-secondary" style="margin-top:16px;" id="review-browse">Browse Items</button>
                `}
            </div>
        `;

        view.querySelectorAll('.review-filter-chip').forEach(button => {
            button.addEventListener('click', () => {
                const group = button.dataset.reviewFilterGroup;
                const value = button.dataset.reviewFilterValue;
                if (!group || !value) return;

                if (value === '__all__') {
                    this.reviewFilters[group] = [];
                } else {
                    this.toggleReviewFilter(group, value);
                }

                this.renderReviewSetup();
            });
        });
        document.getElementById('review-clear-filters')?.addEventListener('click', () => {
            this.reviewFilters = this.getDefaultReviewFilters();
            this.renderReviewSetup();
        });
        document.getElementById('review-start-all')?.addEventListener('click', () => {
            this.startReviewSession(undefined, { filters: this.cloneReviewFilters(this.reviewFilters) });
        });
        document.getElementById('review-start-10')?.addEventListener('click', () => {
            this.startReviewSession(10, { filters: this.cloneReviewFilters(this.reviewFilters) });
        });
        document.getElementById('review-start-saved')?.addEventListener('click', () => {
            this.startReviewSession(undefined, { filters: this.cloneReviewFilters(this.reviewFilters), includeAll: true });
        });
        document.getElementById('review-start-saved-10')?.addEventListener('click', () => {
            this.startReviewSession(10, { filters: this.cloneReviewFilters(this.reviewFilters), includeAll: true });
        });
        document.getElementById('review-browse')?.addEventListener('click', () => this.navigate('vocab'));
    }

    async startReviewSession(limit, options = {}) {
        let due = options.includeAll ? await this.db.getAllHighlights() : await this.db.getDueHighlights();
        const filters = options.filters || this.getDefaultReviewFilters();
        due = this.filterReviewItems(due, filters);

        for (let i = due.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [due[i], due[j]] = [due[j], due[i]];
        }

        if (limit) due = due.slice(0, limit);
        if (due.length === 0) {
            const message = this.hasActiveReviewFilters(filters)
                ? `No ${options.includeAll ? 'saved items' : 'due items'} match the current filters`
                : (options.includeAll ? 'No saved items available for review' : 'No items due for review');
            this.showToast(message, '');
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
        this.scheduleAutoBackup('review progress');
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

    async exportData(options = {}) {
        try {
            await this.refreshBackupState();
            const encrypted = options.encrypted !== false;

            if (this.backupState.fsAccessSupported) {
                const saved = await this.writeBackupToFolder({
                    encrypted,
                    passphrase: options.passphrase || '',
                    promptForDirectory: options.promptForDirectory !== false,
                    useLatestName: !!options.useLatestName,
                    auto: !!options.auto
                });
                if (saved) {
                    this.closeModal();
                }
                return saved;
            }

            if (this.backupState.fileSaveSupported) {
                const saved = await this.writeBackupWithSavePicker({
                    encrypted,
                    passphrase: options.passphrase || '',
                    useLatestName: !!options.useLatestName
                });
                if (saved) {
                    this.closeModal();
                }
                return saved;
            }

            const backup = await this.createBackupPackage(options);
            const fileName = this.getBackupFileName({
                encrypted,
                latest: !!options.useLatestName
            });
            this.downloadText(this.stringifyBackupFile(backup), fileName);
            this.recordBackupEvent(encrypted ? 'download-encrypted' : 'download');
            this.closeModal();
            this.showToast(encrypted ? 'Encrypted backup downloaded to the browser location.' : 'Backup downloaded to the browser location.', 'success');
            return true;
        } catch (e) {
            this.showToast('Backup failed: ' + e.message, 'error');
            return false;
        }
    }

    async importData(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            await this.loadBackupIntoRestoreFlow(data, {
                fileName: file.name,
                restoreSource: 'manual-file'
            });
        } catch (e) {
            this.showToast('Restore failed: ' + e.message, 'error');
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