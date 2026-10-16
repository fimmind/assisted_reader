import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReaderPages, readerPageIndexForLocation } from '../src/core/reader-pagination.js';
import type { ReaderPaginationSegment } from '../src/core/reader-pagination.js';

test('pagination keeps wrapped card rows whole when their heights differ', () => {
  const segments: ReaderPaginationSegment[] = [
    { kind: 'text-line', blockIndex: 0, startOffset: 0, endOffset: 10, startY: 0, endY: 18 },
    { kind: 'atomic', blockIndex: 0, startOffset: 10, endOffset: 10, startY: 22, endY: 92 },
    { kind: 'atomic', blockIndex: 0, startOffset: 10, endOffset: 10, startY: 96, endY: 156 },
    { kind: 'text-line', blockIndex: 1, startOffset: 0, endOffset: 12, startY: 160, endY: 178 },
  ];

  const pages = buildReaderPages(segments, 120, 0);

  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((page) => [page.startY, page.endY]), [[0, 92], [96, 178]]);
  assert.deepEqual(pages.map((page) => page.issues), [[], []]);
  assert.equal(pages[0].endLocation.textOffset, 10);
  assert.equal(pages[1].startLocation.textOffset, 10);
  assert.equal(pages[1].endLocation.blockIndex, 1);
  assert.equal(pages[1].endLocation.textOffset, 12);
});

test('paragraph lines span consecutive pages without losing canonical offsets', () => {
  const segments: ReaderPaginationSegment[] = [
    { kind: 'text-line', blockIndex: 3, startOffset: 0, endOffset: 10, startY: 0, endY: 18 },
    { kind: 'text-line', blockIndex: 3, startOffset: 10, endOffset: 21, startY: 22, endY: 40 },
    { kind: 'text-line', blockIndex: 3, startOffset: 21, endOffset: 33, startY: 44, endY: 62 },
    { kind: 'text-line', blockIndex: 3, startOffset: 33, endOffset: 42, startY: 66, endY: 84 },
  ];

  const pages = buildReaderPages(segments, 45, 2);

  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((page) => [page.startLocation.textOffset, page.endLocation.textOffset]), [[0, 21], [21, 42]]);
  assert.equal(readerPageIndexForLocation(pages, { chapterIndex: 2, blockIndex: 3, textOffset: 21 }), 1);
  assert.equal(readerPageIndexForLocation(pages, { chapterIndex: 3, blockIndex: 3, textOffset: 21 }), null);
});

test('oversized visual segments are surfaced as a page issue', () => {
  const segments: ReaderPaginationSegment[] = [
    { kind: 'atomic', blockIndex: 4, startOffset: 0, endOffset: 0, startY: 10, endY: 160 },
  ];

  const pages = buildReaderPages(segments, 100, 1);

  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].issues, [{
    type: 'oversized-segment',
    blockIndex: 4,
    segmentKind: 'atomic',
    segmentHeight: 150,
    pageHeight: 100,
  }]);
});
