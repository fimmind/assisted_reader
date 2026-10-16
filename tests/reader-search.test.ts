import test from 'node:test';
import assert from 'node:assert/strict';
import { searchBookText } from '../src/core/reader-search.js';
import type { ImportedBook } from '../src/core/types.js';

const book: ImportedBook = {
  id: 'search-book', title: 'Search Book', author: 'Author', sourceType: 'txt',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  currentChapter: 1, currentChapterProgress: 0,
  chapters: [
    { title: 'First', paragraphs: ['The moon rises.'], readerBlocks: [
      { type: 'image', afterParagraphIndex: 0, src: 'data:image/png;base64,AA==', alt: '' },
    ] },
    { title: 'Supplementary', paragraphs: ['Moon map'], linear: false },
  ],
};

test('book search returns canonical offsets, reader block locations, and bounded snippets', async () => {
  const matches = await searchBookText(book, 'MOON', { maxResults: 2, contextCharacters: 2 });
  assert.equal(matches.length, 2);
  assert.deepEqual(matches[0], {
    chapterIndex: 0,
    paragraphIndex: 0,
    startOffset: 4,
    endOffset: 8,
    location: { chapterIndex: 0, blockIndex: 1, textOffset: 4 },
    snippet: 'e moon r',
    snippetStartOffset: 2,
  });
  assert.equal(matches[1].chapterIndex, 1);
});

test('book search stops promptly when cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await searchBookText(book, 'moon', { maxResults: 10, signal: controller.signal }), []);
});

test('book search yields between batches so a running search can be cancelled', async () => {
  const controller = new AbortController();
  const largeBook: ImportedBook = {
    ...book,
    chapters: [{ title: 'Many paragraphs', paragraphs: Array.from({ length: 64 }, () => 'moon') }],
  };
  setTimeout(() => controller.abort(), 0);
  const matches = await searchBookText(largeBook, 'moon', { maxResults: 100, signal: controller.signal });
  assert.ok(matches.length > 0 && matches.length < 100);
});
