const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function worker(scope = 'https://example.test/JP_learning/') {
    const handlers = {};
    const stores = new Map();
    const fetched = [];
    let failDownload = false;
    const caches = {
        async open(name) {
            if (!stores.has(name)) stores.set(name, new Map());
            const entries = stores.get(name);
            return {
                async addAll(requests) {
                    if (failDownload) throw new Error('Offline');
                    for (const request of requests) entries.set(request.url, `cached:${request.url}`);
                },
                async match(request) { return entries.get(typeof request === 'string' ? request : request.url); }
            };
        },
        async keys() { return [...stores.keys()]; },
        async delete(name) { return stores.delete(name); }
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), {
        self: { registration: { scope }, location: new URL(scope), clients: { async claim() {} },
            addEventListener: (name, callback) => { handlers[name] = callback; } },
        caches, URL, Request, Set,
        fetch: async request => { fetched.push(request.url); throw new Error('Network unavailable'); }
    });
    return {
        stores, fetched, caches,
        failDownloads() { failDownload = true; },
        async lifecycle(name) {
            let pending;
            handlers[name]({ waitUntil(promise) { pending = promise; } });
            await pending;
        },
        async fetch(url, mode = 'cors', method = 'GET') {
            let result;
            handlers.fetch({ request: { url, mode, method }, respondWith(promise) { result = promise; } });
            return result;
        }
    };
}

test('offline launch works at both domain root and GitHub Pages subpath', async () => {
    for (const scope of ['https://example.test/', 'https://example.test/JP_learning/']) {
        const sw = worker(scope);
        await sw.lifecycle('install');
        assert.equal(await sw.fetch(`${scope}?from=homescreen`, 'navigate'), `cached:${scope}index.html`);
        assert.equal(await sw.fetch(`${scope}vendor/pdf.worker.min.js`), `cached:${scope}vendor/pdf.worker.min.js`);
        assert.deepEqual(sw.fetched, []);
    }
});

test('worker leaves authentication, private files, APIs, and other apps to the network', async () => {
    const sw = worker();
    await sw.lifecycle('install');
    for (const [url, mode, method] of [
        ['https://example.test/__/auth/handler', 'navigate', 'GET'],
        ['https://example.test/JP_learning/private-file.pdf', 'cors', 'GET'],
        ['https://example.test/another-app/', 'navigate', 'GET'],
        ['https://firestore.googleapis.com/v1/users', 'cors', 'GET'],
        ['https://example.test/JP_learning/', 'cors', 'POST']
    ]) assert.equal(await sw.fetch(url, mode, method), undefined);
});

test('activation only removes older app-shell caches within its own scope', async () => {
    const sw = worker();
    const old = 'langlens:https://example.test/JP_learning/:old';
    await sw.caches.open(old);
    await sw.caches.open('another-app');
    await sw.caches.open('langlens:https://example.test/:other-scope');
    await sw.lifecycle('install');
    await sw.lifecycle('activate');
    assert.equal(sw.stores.has(old), false);
    assert.equal(sw.stores.has('another-app'), true);
    assert.equal(sw.stores.has('langlens:https://example.test/:other-scope'), true);
});

test('failed update preserves the previous cached app', async () => {
    const sw = worker();
    const old = 'langlens:https://example.test/JP_learning/:old';
    await sw.caches.open(old);
    sw.failDownloads();
    await assert.rejects(sw.lifecycle('install'), /Offline/);
    assert.equal(sw.stores.has(old), true);
});

test('every precached asset exists and all local page dependencies are precached', async () => {
    const sw = worker();
    await sw.lifecycle('install');
    const assets = [...sw.stores.values()][0];
    const scope = 'https://example.test/JP_learning/';
    for (const url of assets.keys()) {
        const local = new URL(url).pathname.replace('/JP_learning/', '') || 'index.html';
        assert.ok(fs.existsSync(path.join(root, local)), local);
    }
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
        if (!match[1].startsWith('https:')) assert.ok(assets.has(new URL(match[1], scope).href), match[1]);
    }
});

test('manifest uses portable standalone launch paths and correctly sized PNG icons', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest')));
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.scope, './');
    assert.equal(manifest.start_url, './');
    for (const icon of manifest.icons) {
        const data = fs.readFileSync(path.join(root, icon.src));
        assert.equal(data.subarray(1, 4).toString(), 'PNG');
        assert.equal(`${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`, icon.sizes);
    }
    assert.ok(manifest.icons.some(icon => icon.sizes === '192x192' && icon.purpose === 'any'));
    assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'any'));
    assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'));
});
