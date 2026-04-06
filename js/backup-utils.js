(function (globalScope) {
    const DEFAULT_BACKUP_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

    class BackupUtils {
        static backupSummary(data = {}) {
            return {
                exportedAt: data.exportedAt || Date.now(),
                schemaVersion: data.schemaVersion || data.version || 0,
                backupVersion: data.backupVersion || 0,
                counts: data.counts || {
                    sources: Array.isArray(data.sources) ? data.sources.length : 0,
                    highlights: Array.isArray(data.highlights) ? data.highlights.length : 0,
                    readingNotes: Array.isArray(data.readingNotes) ? data.readingNotes.length : 0
                }
            };
        }

        static getBackupReminder({
            totalSources = 0,
            totalHighlights = 0,
            totalReadingNotes = 0,
            lastBackupAt = 0,
            thresholdMs = DEFAULT_BACKUP_THRESHOLD_MS,
            now = Date.now()
        } = {}) {
            const hasData = (totalSources + totalHighlights + totalReadingNotes) > 0;
            if (!hasData) {
                return { shouldShow: false, kind: 'empty', ageMs: 0, thresholdMs };
            }

            if (!lastBackupAt) {
                return {
                    shouldShow: true,
                    kind: 'missing',
                    ageMs: Infinity,
                    thresholdMs,
                    title: 'Backup recommended',
                    message: 'No backup saved yet. Create one so this local library can be restored later.'
                };
            }

            const ageMs = Math.max(0, now - lastBackupAt);
            if (ageMs < thresholdMs) {
                return { shouldShow: false, kind: 'fresh', ageMs, thresholdMs };
            }

            return {
                shouldShow: true,
                kind: 'stale',
                ageMs,
                thresholdMs,
                title: 'Backup overdue',
                message: 'Your last backup is older than the recommended threshold for a browser-only library.'
            };
        }

        static toBase64(buffer) {
            if (typeof Buffer !== 'undefined') {
                return Buffer.from(buffer).toString('base64');
            }

            const bytes = new Uint8Array(buffer);
            const chunkSize = 0x8000;
            let binary = '';
            for (let i = 0; i < bytes.length; i += chunkSize) {
                binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
            }
            return btoa(binary);
        }

        static fromBase64(value) {
            if (typeof Buffer !== 'undefined') {
                const buffer = Buffer.from(value, 'base64');
                return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
            }

            const binary = atob(value);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return bytes.buffer;
        }

        static async deriveKey(passphrase, salt, usages, cryptoImpl = globalScope.crypto) {
            if (!cryptoImpl?.subtle) {
                throw new Error('Web Crypto is not available');
            }

            const encoder = new TextEncoder();
            const baseKey = await cryptoImpl.subtle.importKey(
                'raw',
                encoder.encode(passphrase),
                'PBKDF2',
                false,
                ['deriveKey']
            );

            return cryptoImpl.subtle.deriveKey({
                name: 'PBKDF2',
                salt,
                iterations: 250000,
                hash: 'SHA-256'
            }, baseKey, {
                name: 'AES-GCM',
                length: 256
            }, false, usages);
        }

        static async encryptBackupData(data, passphrase, cryptoImpl = globalScope.crypto, options = {}) {
            if (!passphrase) {
                throw new Error('A passphrase is required for encrypted backups');
            }

            const summary = BackupUtils.backupSummary(data);
            const salt = options.salt ? new Uint8Array(options.salt) : cryptoImpl.getRandomValues(new Uint8Array(16));
            const iv = options.iv ? new Uint8Array(options.iv) : cryptoImpl.getRandomValues(new Uint8Array(12));
            const key = await BackupUtils.deriveKey(passphrase, salt, ['encrypt'], cryptoImpl);
            const encoded = new TextEncoder().encode(JSON.stringify(data));
            const encrypted = await cryptoImpl.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

            return {
                format: 'langlens-backup',
                backupVersion: summary.backupVersion || 1,
                schemaVersion: summary.schemaVersion,
                exportedAt: summary.exportedAt,
                encrypted: true,
                counts: summary.counts,
                encryption: {
                    algorithm: 'AES-GCM',
                    kdf: 'PBKDF2',
                    hash: 'SHA-256',
                    iterations: 250000,
                    salt: BackupUtils.toBase64(salt),
                    iv: BackupUtils.toBase64(iv)
                },
                payload: BackupUtils.toBase64(encrypted)
            };
        }

        static async decryptBackupData(data, passphrase, cryptoImpl = globalScope.crypto) {
            if (!data?.encrypted || !data?.payload || !data?.encryption?.salt || !data?.encryption?.iv) {
                throw new Error('Invalid encrypted backup file');
            }

            try {
                const salt = new Uint8Array(BackupUtils.fromBase64(data.encryption.salt));
                const iv = new Uint8Array(BackupUtils.fromBase64(data.encryption.iv));
                const key = await BackupUtils.deriveKey(passphrase, salt, ['decrypt'], cryptoImpl);
                const decrypted = await cryptoImpl.subtle.decrypt({ name: 'AES-GCM', iv }, key, BackupUtils.fromBase64(data.payload));
                const text = new TextDecoder().decode(decrypted);
                return JSON.parse(text);
            } catch {
                throw new Error('Unable to decrypt backup. Check the passphrase and try again.');
            }
        }
    }

    BackupUtils.DEFAULT_BACKUP_THRESHOLD_MS = DEFAULT_BACKUP_THRESHOLD_MS;

    globalScope.BackupUtils = BackupUtils;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = BackupUtils;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);