const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Resvg } = require('@resvg/resvg-js');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const svg = fs.readFileSync(path.join(root, 'favicon.svg'), 'utf8');
fs.mkdirSync(path.join(root, 'icons'), { recursive: true });
for (const [name, size, maskable] of [
    ['icon-192.png', 192, false], ['icon-512.png', 512, false],
    ['apple-touch-icon.png', 180, true], ['icon-maskable-512.png', 512, true]
]) {
    // Keep the entire existing logo inside the central mask-safe circle.
    const source = maskable
        ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0f766e"/><g transform="translate(12 12) scale(0.625)">${svg.replace(/<svg[^>]*>|<\/svg>/g, '')}</g></svg>`
        : svg;
    fs.writeFileSync(path.join(root, 'icons', name), new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng());
}

// Explicit publish allowlist: never include local databases, credentials, tests, or logs.
const files = ['index.html', 'styles.css', 'favicon.svg', 'manifest.webmanifest'];
for (const dir of ['js', 'icons', 'vendor']) {
    for (const name of fs.readdirSync(path.join(root, dir)).sort()) {
        if (fs.statSync(path.join(root, dir, name)).isFile()) files.push(`${dir}/${name}`);
    }
}
const swPath = path.join(root, 'sw.js');
const sw = fs.readFileSync(swPath, 'utf8');
const versionPattern = /const CACHE_VERSION = '[^']+';/;
const hash = crypto.createHash('sha256').update(sw.replace(versionPattern, "const CACHE_VERSION = '';"));
for (const file of files) hash.update(file).update(fs.readFileSync(path.join(root, file)));
const version = hash.digest('hex').slice(0, 16);
fs.writeFileSync(swPath, sw.replace(versionPattern, `const CACHE_VERSION = 'langlens-shell-${version}';`));
files.push('sw.js');
// Only this known generated directory is cleaned.
fs.rmSync(dist, { recursive: true, force: true });
for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dist, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(dist, file));
}
console.log(`Built ${files.length} public files; offline version ${version}`);
