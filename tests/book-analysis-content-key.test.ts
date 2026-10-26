import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { BookChapter } from '../src/core/types';
import { getBookAnalysisContentKey } from '../src/core/book-analysis-content-key.js';

function expectedKey(paragraphGroups: string[][]): string {
  const serialized = JSON.stringify(paragraphGroups);
  const digest = createHash('sha256').update(serialized, 'utf8').digest('hex');
  return `paragraphs-v1:sha256:${digest}`;
}

function createBook(chapters: BookChapter[]): { chapters: BookChapter[] } {
  return { chapters };
}

test('book analysis content key matches SHA-256 of canonical paragraph groups', async () => {
  const books = [
    createBook([]),
    createBook([{ title: 'empty', paragraphs: [] }]),
    createBook([{ title: 'multibyte', paragraphs: ['Привет, 世界 🌍'] }]),
    ...[0, 49, 50, 51, 57, 58, 59, 113, 114, 115, 121, 122].map((length) =>
      createBook([{ title: `length-${length}`, paragraphs: ['x'.repeat(length)] }])),
    createBook([{ title: 'two', paragraphs: ['alpha', 'βeta'] }, { title: 'three', paragraphs: ['gamma'] }]),
  ];

  for (const book of books) {
    const groups = book.chapters.map((chapter) => chapter.paragraphs);
    assert.equal(await getBookAnalysisContentKey(book), expectedKey(groups));
  }
});

test('book analysis content key ignores titles and preserves text and grouping distinctions', async () => {
  const original = createBook([{ title: 'Original', paragraphs: ['one', 'two'] }, { title: 'Part 2', paragraphs: ['three'] }]);
  const sameText = createBook([{ title: 'Renamed', paragraphs: ['one', 'two'] }, { title: 'Other', paragraphs: ['three'] }]);
  const reparagraph = createBook([{ title: 'Original', paragraphs: ['one two'] }, { title: 'Part 2', paragraphs: ['three'] }]);
  const regrouped = createBook([{ title: 'Original', paragraphs: ['one', 'two', 'three'] }]);
  const snapshot = JSON.stringify(original);

  assert.equal(await getBookAnalysisContentKey(original), await getBookAnalysisContentKey(sameText));
  assert.notEqual(await getBookAnalysisContentKey(original), await getBookAnalysisContentKey(reparagraph));
  assert.notEqual(await getBookAnalysisContentKey(original), await getBookAnalysisContentKey(regrouped));
  assert.equal(JSON.stringify(original), snapshot);
});
