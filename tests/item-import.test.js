const test = require('node:test');
const assert = require('node:assert/strict');

const ItemImportUtils = require('../js/item-import-utils.js');

test('parseItemListText supports colon-separated notes and text-only lines', () => {
    const result = ItemImportUtils.parseItemListText('\ufeffword1: explanation1\r\nword2：説明2\nword3');

    assert.deepEqual(result.items.map(item => ({
        text: item.text,
        note: item.note,
        lineNumber: item.lineNumber
    })), [
        { text: 'word1', note: 'explanation1', lineNumber: 1 },
        { text: 'word2', note: '説明2', lineNumber: 2 },
        { text: 'word3', note: '', lineNumber: 3 }
    ]);
    assert.equal(result.summary.blankLines, 0);
    assert.equal(result.summary.invalidLines, 0);
});

test('parseItemListText skips blank lines and invalid lines without text', () => {
    const result = ItemImportUtils.parseItemListText('\n  \n:note only\nterm:has:extra\n');

    assert.deepEqual(result.items.map(item => ({ text: item.text, note: item.note })), [
        { text: 'term', note: 'has:extra' }
    ]);
    assert.equal(result.summary.blankLines, 3);
    assert.equal(result.summary.invalidLines, 1);
    assert.equal(result.skippedLines[0].lineNumber, 3);
});

test('planItemImport skips existing duplicates and duplicate rows in the same file', () => {
    const plan = ItemImportUtils.planItemImport([
        { text: 'word', note: 'note' },
        { text: 'other', note: '' },
        { text: 'OTHER', note: '' }
    ], {
        category: 'vocab',
        existingItems: [
            { text: 'word', note: 'note', category: 'vocab', sourceId: null }
        ]
    });

    assert.deepEqual(plan.itemsToImport, [
        { text: 'other', note: '', category: 'vocab', sourceId: null }
    ]);
    assert.equal(plan.summary.imported, 1);
    assert.equal(plan.summary.skippedExisting, 1);
    assert.equal(plan.summary.skippedInFile, 1);
});