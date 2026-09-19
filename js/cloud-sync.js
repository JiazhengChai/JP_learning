/* Optional Firebase sync. IndexedDB remains the durable offline working copy. */
class CloudSync {
    constructor(app) {
        this.app = app;
        this.user = null;
        this.resolutions = {};
        this.conflicts = [];
        this.running = false;
        this.message = 'Saved on this browser';
        this.timer = null;
    }

    async prepare() {
        this.config = window.LANGLENS_FIREBASE_CONFIG;
        if (!this.config?.apiKey || !this.config?.appId) return;
        try { await this.connect(); }
        catch (error) {
            // A transient SDK/network failure must not make locally saved work
            // inaccessible. The hint only selects a local cache, never authorizes
            // cloud access. Firebase rules remain the cloud access boundary.
            const uid = localStorage.getItem('langlens-account-cache');
            if (uid) this.app.db = new Database(`${DB_NAME}-account-${uid}`, true);
            this.auth = null;
            this.user = null;
            this.message = 'Cloud connection unavailable · working locally. Reload to reconnect.';
            console.warn('Firebase connection unavailable:', error);
        }
    }

    async connect() {
        // Pinned modules retain the existing static-site deployment workflow.
        const url = 'https://www.gstatic.com/firebasejs/12.19.0/';
        const [sdk, auth, firestore, storage] = await Promise.all([
            import(`${url}firebase-app.js`), import(`${url}firebase-auth.js`),
            import(`${url}firebase-firestore.js`), import(`${url}firebase-storage.js`)
        ]);
        this.authSDK = auth;
        this.fs = firestore;
        this.storageSDK = storage;
        const firebase = sdk.initializeApp(this.config);
        this.auth = auth.getAuth(firebase);
        this.firestore = firestore.getFirestore(firebase);
        this.storage = this.config.storageBucket ? storage.getStorage(firebase) : null;
        await auth.setPersistence(this.auth, auth.browserLocalPersistence);
        await this.auth.authStateReady();
        this.user = this.auth.currentUser;
        if (this.user) {
            localStorage.setItem('langlens-account-cache', this.user.uid);
            this.app.db = new Database(`${DB_NAME}-account-${this.user.uid}`, true);
        } else localStorage.removeItem('langlens-account-cache');
        auth.onAuthStateChanged(this.auth, user => {
            if ((user?.uid || null) !== (this.user?.uid || null)) {
                if (!user) localStorage.removeItem('langlens-account-cache');
                location.reload();
            }
        });
    }

    start() {
        this.render();
        if (!this.user) return;
        this.meta = this.fs.doc(this.firestore, 'users', this.user.uid, 'sync', 'state');
        this.app.db.onLibraryChange = () => { this.setStatus('Saved locally · syncing soon'); this.schedule(); };
        this.fs.onSnapshot(this.meta, { includeMetadataChanges: true }, snapshot => {
            if (!snapshot.metadata.hasPendingWrites && !snapshot.metadata.fromCache) this.schedule();
        }, error => this.fail(error));
        window.addEventListener('online', () => this.schedule(0));
        window.addEventListener('offline', () => this.setStatus('Offline · changes saved on this device'));
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) this.schedule(0);
        });
        this.schedule(0);
    }

    setStatus(message) { this.message = message; this.render(); }

    render() {
        const panel = document.getElementById('cloud-panel');
        if (!panel) return;
        panel.replaceChildren();
        const status = document.createElement('div');
        status.className = 'backup-footer-status';
        status.setAttribute('role', 'status');
        status.textContent = this.message;
        panel.append(status);
        const button = (label, action) => {
            const element = document.createElement('button');
            element.className = 'btn-subtle btn-subtle-full';
            element.textContent = label;
            element.onclick = async () => {
                element.disabled = true;
                try { await action(); } catch (error) { this.fail(error); }
                finally { element.disabled = false; }
            };
            panel.append(element);
        };
        if (!this.auth) return;
        if (!this.user) {
            button('Sign in with Google', () => this.authSDK.signInWithPopup(this.auth, new this.authSDK.GoogleAuthProvider()));
            return;
        }
        const account = document.createElement('div');
        account.className = 'cloud-account';
        account.textContent = this.user.email || 'Google account';
        panel.prepend(account);
        button(this.conflicts.length ? `Review ${this.conflicts.length} sync conflicts` : 'Sync now', () => this.conflicts.length ? this.reviewConflicts() : this.sync());
        button('Bring local progress into this account', () => this.importLocal());
        button('Sign out', async () => {
            // Pending edits stay in this account's separate database.
            await this.authSDK.signOut(this.auth);
        });
    }

    schedule(delay = 1500) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.sync(), delay);
    }

    editing() {
        return this.app.isModalOpen() || this.app.currentView === 'reader' ||
            (this.app.currentView === 'review' && this.app.reviewSession);
    }

    fail(error) {
        console.error('Cloud sync:', error);
        this.setStatus(`Saved locally · ${error.message || 'cloud sync unavailable'}`);
    }

    async importLocal() {
        const guest = new Database();
        await guest.init();
        try {
            const payload = await guest.exportAll();
            if (!SyncCore.stores.some(name => payload[name].length)) {
                this.app.showToast('No local guest progress to import. You can restore a JSON backup instead.');
                return;
            }
            await this.app.db.importAll(payload, { mode: 'merge' });
            await guest.setSetting('cloud-migrated-account', this.user.uid);
            this.app.showToast('Local progress added to this account. The original local copy is still available when signed out.');
            await this.app.navigate('dashboard');
            this.schedule(0);
        } finally { guest.db.close(); }
    }

    async recoverLocalIfEmpty(captured, remote) {
        // Only migrate into a never-used cloud account. A cloud deletion must
        // never resurrect the guest library, nor move it into another account.
        if (remote.revision || captured.state?.revision ||
            SyncCore.stores.some(name => captured.data[name].length || remote.data[name].length)) return false;
        const guest = new Database();
        await guest.init();
        try {
            if (await guest.getSetting('cloud-migrated-account')) return false;
            const payload = await guest.exportAll();
            if (!SyncCore.stores.some(name => payload[name].length)) return false;
            this.setStatus('Moving your existing progress into this account…');
            await this.app.db.importAll(payload, { mode: 'merge' });
            await guest.setSetting('cloud-migrated-account', this.user.uid);
            this.app.showToast('Your existing progress is now in this account. The original local copy is preserved.');
            await this.app.navigate('dashboard');
            return true;
        } finally { guest.db.close(); }
    }

    async reviewConflicts() {
        const conflict = this.conflicts[0];
        if (!conflict) return;
        const describe = value => {
            if (value === undefined) return 'Deleted';
            const details = [];
            for (const [field, label] of [['title', 'Title'], ['text', 'Text'], ['note', 'Note'], ['content', 'Source text'], ['category', 'Category'], ['fileName', 'File'], ['drawingTool', 'Drawing']]) {
                if (value[field]) {
                    const text = String(value[field]);
                    details.push(`${label}: ${text.length > 2500 ? text.slice(0, 2500) + '… (preview)' : text}`);
                }
            }
            if (Number.isFinite(value.reviewCount)) details.push(`Reviews completed: ${value.reviewCount}`);
            if (Number.isFinite(value.masteryLevel)) details.push(`Mastery: ${this.app.masteryName(value.masteryLevel)}`);
            if (value.nextReviewAt) details.push(`Next review: ${this.app.formatDateTime(value.nextReviewAt)}`);
            if (value.updatedAt) details.push(`Last changed: ${this.app.formatDateTime(value.updatedAt)}`);
            return details.join('\n\n') || 'Saved record';
        };
        const label = { sources: 'source', highlights: 'study item', readingNotes: 'reading note' }[conflict.store];
        this.app.showModal(`<h2>Choose which version to keep</h2>
            <p>Both devices changed this ${label}. Your local version is preserved until you choose.</p>
            ${conflict.reason ? `<p>${this.app.esc(conflict.reason)}</p>` : ''}
            <h3>This device</h3><pre class="cloud-conflict">${this.app.esc(describe(conflict.local))}</pre>
            <h3>Cloud</h3><pre class="cloud-conflict">${this.app.esc(describe(conflict.remote))}</pre>
            <div class="modal-actions"><button id="cloud-keep-local" class="btn btn-primary">Keep this device's version</button>
            <button id="cloud-keep-remote" class="btn btn-secondary">Keep cloud version</button></div>`);
        for (const choice of ['local', 'remote']) {
            document.getElementById(`cloud-keep-${choice}`).onclick = () => {
                this.resolutions[SyncCore.key(conflict.store, conflict.id)] = { ...conflict, choice };
                this.conflicts.shift();
                this.app.closeModal();
                if (this.conflicts.length) this.reviewConflicts();
                else this.schedule(0);
            };
        }
    }

    async encode(record) {
        const value = { ...record };
        if (value.fileDataUrl) {
            if (!this.storage) throw new Error('File sync needs Cloud Storage enabled for this project');
            const blob = await (await fetch(value.fileDataUrl)).blob();
            if (blob.size > 50 * 1024 * 1024) throw new Error('File exceeds the 50 MB cloud sync limit');
            const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(n => n.toString(16).padStart(2, '0')).join('');
            const path = `users/${this.user.uid}/files/${hash}`;
            const ref = this.storageSDK.ref(this.storage, path);
            try { await this.storageSDK.getMetadata(ref); }
            catch (error) {
                if (error.code !== 'storage/object-not-found') throw error;
                await this.storageSDK.uploadBytes(ref, blob, { contentType: blob.type || 'application/octet-stream' });
            }
            value.fileDataUrl = '';
            value.cloudAttachment = { path, mime: blob.type };
        }
        const payload = JSON.stringify(value);
        if (new TextEncoder().encode(payload).length > 750000) throw new Error('One text or note is too large to sync (750 KB limit)');
        return { payload };
    }

    async decode(document, cache) {
        const value = JSON.parse(document.data().payload);
        if (!Number.isSafeInteger(value.id) || String(value.id) !== document.id) throw new Error('Invalid cloud record ID');
        if (value.cloudAttachment) {
            const { path, mime } = value.cloudAttachment;
            if (!path.startsWith(`users/${this.user.uid}/files/`)) throw new Error('Invalid cloud attachment path');
            const cached = cache.find(row => row.id === value.id && row.cloudAttachment?.path === path && row.fileDataUrl);
            if (cached) value.fileDataUrl = cached.fileDataUrl;
            else {
                if (!this.storage) throw new Error('Cloud Storage is required to load this file');
                const bytes = await this.storageSDK.getBytes(this.storageSDK.ref(this.storage, path), 50 * 1024 * 1024);
                value.fileDataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => reject(reader.error);
                    reader.readAsDataURL(new Blob([bytes], { type: mime }));
                });
            }
        }
        return value;
    }

    async readRemote(state) {
        const { fs } = this;
        for (let attempt = 0; attempt < 4; attempt++) {
            const before = (await fs.getDocFromServer(this.meta)).data()?.revision || 0;
            if (state?.revision === before) return state;
            const data = SyncCore.empty();
            for (const store of SyncCore.stores) {
                const snapshot = await fs.getDocsFromServer(fs.collection(this.firestore, 'users', this.user.uid, store));
                for (const doc of snapshot.docs) data[store].push(await this.decode(doc, state?.data?.[store] || []));
            }
            const after = (await fs.getDocFromServer(this.meta)).data()?.revision || 0;
            if (before === after) return { revision: after, data };
        }
        throw new Error('Another device is saving. Sync will retry shortly.');
    }

    async sync() {
        if (!this.user || this.auth.currentUser?.uid !== this.user.uid) return;
        if (this.running || this.app.db.syncBusy) { this.schedule(); return; }
        if (!navigator.onLine) { this.setStatus('Offline · changes saved on this device'); return; }
        this.running = true;
        try {
            // Serialize sync across tabs for this account. Database writes can
            // still happen while the network is busy; acknowledgeSync preserves them.
            if (!navigator.locks) throw new Error('This browser needs Web Locks support for safe cloud sync');
            await navigator.locks.request(`langlens-sync-${this.user.uid}`, async () => {
                if (this.app.db.syncBusy) { this.schedule(); return; }
                this.setStatus('Syncing…');
                let captured = await this.app.db.readSyncSnapshot();
                const remote = await this.readRemote(captured.state);
                if (!this.editing() && await this.recoverLocalIfEmpty(captured, remote)) {
                    captured = await this.app.db.readSyncSnapshot();
                }
                const base = captured.state?.data || SyncCore.empty();
                if (this.editing() && SyncCore.changes(base, remote.data).length) {
                    this.setStatus('Cloud updates waiting · finish editing to sync');
                    this.schedule(5000);
                    return;
                }
                const merged = SyncCore.merge(base, captured.data, remote.data, this.resolutions);
                this.conflicts = merged.conflicts;
                if (this.conflicts.length) {
                    this.setStatus('Sync paused · choose which conflicting edits to keep');
                    return;
                }
                const candidates = SyncCore.changes(remote.data, merged.data);
                const edits = [];
                const encoded = [];
                const blocked = [];
                let bytes = 0;
                for (const edit of candidates) {
                    if (edit.value?.sourceId && !remote.data.sources.some(row => row.id === edit.value.sourceId) &&
                        !edits.some(item => item.store === 'sources' && item.id === edit.value.sourceId && item.value)) {
                        blocked.push('Linked source is not synced yet');
                        continue;
                    }
                    let document;
                    try { document = edit.value === undefined ? null : await this.encode(edit.value); }
                    catch (error) { blocked.push(error.message); continue; }
                    const previous = remote.data[edit.store].find(row => row.id === edit.id);
                    const previousPayload = previous ? JSON.stringify({ ...previous, fileDataUrl: '' }) : '';
                    const size = new TextEncoder().encode((document?.payload || '') + previousPayload).length;
                    if (edits.length >= 400 || (edits.length && bytes + size > 6 * 1024 * 1024)) break;
                    edits.push(edit);
                    encoded.push(document);
                    bytes += size;
                }
                let published = remote;
                if (this.editing() && SyncCore.changes(captured.data, merged.data).length) {
                    this.schedule(5000);
                    return;
                }
                if (edits.length) {
                    await this.fs.runTransaction(this.firestore, async transaction => {
                        const version = (await transaction.get(this.meta)).data()?.revision || 0;
                        if (version !== remote.revision) throw new Error('Another device saved first. Retrying sync.');
                        for (let i = 0; i < edits.length; i++) {
                            const edit = edits[i];
                            const ref = this.fs.doc(this.firestore, 'users', this.user.uid, edit.store, String(edit.id));
                            if (encoded[i] === null) transaction.delete(ref);
                            else transaction.set(ref, encoded[i]);
                        }
                        transaction.set(this.meta, { revision: version + 1, updatedAt: this.fs.serverTimestamp() });
                    });
                    published = { revision: remote.revision + 1, data: SyncCore.apply(remote.data, edits) };
                }
                if (this.editing() && SyncCore.changes(captured.data, merged.data).length) {
                    this.schedule(5000);
                    return;
                }
                const changed = await this.app.db.acknowledgeSync(captured.data, merged.data, published);
                this.resolutions = {};
                const current = await this.app.db.readSyncSnapshot();
                const pending = SyncCore.changes(published.data, current.data).length;
                if (pending && edits.length) this.schedule();
                const hasProgress = SyncCore.stores.some(name => current.data[name].length);
                this.setStatus(blocked.length ? `${pending} records still local · ${blocked[0]}` : pending ? 'Saved locally · finishing cloud sync' :
                    hasProgress ? `Saved to cloud · ${current.data.highlights.length} items, ${current.data.sources.length} sources` :
                    'Cloud library is empty · open your original browser to sync existing progress');
                if (changed) {
                    await this.app.updateReviewBadge();
                    // Do not redraw an open editor or interrupt a review session.
                    this.app.showToast('Progress updated from the cloud.');
                    if (!this.editing()) await this.app.navigate(this.app.currentView);
                }
            });
        } catch (error) {
            this.fail(error);
            this.schedule(30000);
        } finally { this.running = false; }
    }
}
if (typeof module !== 'undefined') module.exports = CloudSync;
