(function (globalScope) {
    class ItemImportUtils {
        static normalizeText(rawText = '') {
            return String(rawText ?? '')
                .replace(/^\ufeff/, '')
                .replace(/\r\n?/g, '\n');
        }

        static getDelimiters(options = {}) {
            const baseDelimiter = typeof options.delimiter === 'string'
                ? options.delimiter.trim()
                : ':';
            const extraDelimiters = Array.isArray(options.extraDelimiters)
                ? options.extraDelimiters
                : [];
            const delimiters = [];

            if (baseDelimiter) {
                delimiters.push(baseDelimiter);
                if (baseDelimiter === ':') {
                    delimiters.push('：');
                }
            }

            extraDelimiters.forEach(delimiter => {
                const normalized = typeof delimiter === 'string' ? delimiter.trim() : '';
                if (normalized) {
                    delimiters.push(normalized);
                }
            });

            return [...new Set(delimiters)];
        }

        static findFirstDelimiter(line, delimiters = []) {
            let match = null;

            delimiters.forEach(delimiter => {
                const index = line.indexOf(delimiter);
                if (index === -1) {
                    return;
                }

                if (!match || index < match.index || (index === match.index && delimiter.length > match.delimiter.length)) {
                    match = { index, delimiter };
                }
            });

            return match;
        }

        static parseItemListText(rawText, options = {}) {
            const normalizedText = ItemImportUtils.normalizeText(rawText);
            const lines = normalizedText.split('\n');
            const delimiters = ItemImportUtils.getDelimiters(options);
            const items = [];
            const skippedLines = [];
            let blankLines = 0;

            lines.forEach((line, index) => {
                const trimmedLine = line.trim();
                if (!trimmedLine) {
                    blankLines++;
                    return;
                }

                const match = ItemImportUtils.findFirstDelimiter(trimmedLine, delimiters);
                const text = (match ? trimmedLine.slice(0, match.index) : trimmedLine).trim();
                const note = (match ? trimmedLine.slice(match.index + match.delimiter.length) : '').trim();

                if (!text) {
                    skippedLines.push({
                        lineNumber: index + 1,
                        raw: line,
                        reason: 'missing-text'
                    });
                    return;
                }

                items.push({
                    text,
                    note,
                    lineNumber: index + 1,
                    raw: line
                });
            });

            return {
                items,
                skippedLines,
                summary: {
                    totalLines: lines.length,
                    parsedItems: items.length,
                    blankLines,
                    invalidLines: skippedLines.length
                }
            };
        }

        static buildItemKey(item = {}, options = {}) {
            const sourceId = options.sourceId !== undefined ? options.sourceId : item.sourceId;
            const category = options.category !== undefined ? options.category : item.category;
            const sourceKey = Number.isFinite(sourceId) ? String(sourceId) : 'manual';

            return [
                sourceKey,
                String(category || '').trim().toLowerCase(),
                String(item.text || '').trim().toLowerCase(),
                String(item.note || '').trim().toLowerCase()
            ].join('::');
        }

        static planItemImport(items = [], options = {}) {
            const category = String(options.category || 'vocab').trim() || 'vocab';
            const sourceId = Number.isFinite(options.sourceId) ? options.sourceId : null;
            const existingItems = Array.isArray(options.existingItems) ? options.existingItems : [];
            const existingKeys = new Set(existingItems.map(item => ItemImportUtils.buildItemKey(item)));
            const incomingKeys = new Set();
            const itemsToImport = [];
            let skippedExisting = 0;
            let skippedInFile = 0;

            items.forEach(item => {
                const candidate = {
                    text: String(item.text || '').trim(),
                    note: String(item.note || '').trim(),
                    category,
                    sourceId
                };
                const key = ItemImportUtils.buildItemKey(candidate);

                if (existingKeys.has(key)) {
                    skippedExisting++;
                    return;
                }

                if (incomingKeys.has(key)) {
                    skippedInFile++;
                    return;
                }

                incomingKeys.add(key);
                itemsToImport.push(candidate);
            });

            return {
                itemsToImport,
                summary: {
                    requested: items.length,
                    imported: itemsToImport.length,
                    skippedExisting,
                    skippedInFile,
                    skippedTotal: skippedExisting + skippedInFile
                }
            };
        }
    }

    globalScope.ItemImportUtils = ItemImportUtils;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = ItemImportUtils;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);