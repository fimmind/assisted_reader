import test from 'node:test';
import assert from 'node:assert/strict';
import { bookProgressAtLocation, readerLocationAtBookProgress, readerLocationFromLegacyProgress, resolveReaderLocation } from '../src/core/reader-location.js';
import type { ImportedBook } from '../src/core/types.js';

const book: ImportedBook = {
  id: 'location-book', title: 'Location Book', author: 'Author', sourceType: 'txt',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  currentChapter: 1, currentChapterProgress: 0,
  chapters: [
    { title: 'Short', paragraphs: ['a', 'bbb'], readerBlocks: [
      { type: 'image', afterParagraphIndex: 1, src: 'data:image/png;base64,AA==', alt: '' },
    ] },
    { title: 'Appendix', paragraphs: ['supplementary'], linear: false },
    { title: 'Long', paragraphs: ['123456789'], },
  ],
};

test('book progress follows canonical text weight and excludes supplementary chapters', () => {
  const atSecondParagraph = { chapterIndex: 0, blockIndex: 2, textOffset: 0 };
  assert.equal(bookProgressAtLocation(book, atSecondParagraph), 1 / 13);
  assert.deepEqual(readerLocationAtBookProgress(book, 0.1), atSecondParagraph);
  assert.deepEqual(readerLocationFromLegacyProgress(book, 1, 1), { chapterIndex: 0, blockIndex: 2, textOffset: 3 });
  assert.equal(bookProgressAtLocation(book, { chapterIndex: 1, blockIndex: 0, textOffset: 0 }), 4 / 13);
  assert.deepEqual(readerLocationAtBookProgress(book, 4 / 13), { chapterIndex: 2, blockIndex: 0, textOffset: 0 });
});

test('location resolution clamps chapter, block, and canonical text offset', () => {
  assert.deepEqual(resolveReaderLocation(book, { chapterIndex: 90, blockIndex: 90, textOffset: 90 }), {
    chapterIndex: 2, blockIndex: 0, textOffset: 9,
  });
  assert.throws(() => resolveReaderLocation(book, { chapterIndex: Number.NaN, blockIndex: 0, textOffset: 0 }), RangeError);
});
