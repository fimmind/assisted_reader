import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreviousReaderPages, buildReaderPages, readerPageIndexForLocation } from '../src/core/reader-pagination.js';
import type { ReaderPaginationCardMetric, ReaderPaginationSegment } from '../src/core/reader-pagination.js';

test('pagination keeps wrapped card rows whole when their heights differ', () => {
  const segments: ReaderPaginationSegment[] = [
    { kind: 'text-line', blockIndex: 0, startOffset: 0, endOffset: 10, startY: 0, endY: 18 },
    { kind: 'atomic', blockIndex: 0, startOffset: 10, endOffset: 10, startY: 22, endY: 92 },
    { kind: 'atomic', blockIndex: 0, startOffset: 10, endOffset: 10, startY: 96, endY: 156 },
    { kind: 'text-line', blockIndex: 1, startOffset: 0, endOffset: 12, startY: 160, endY: 178 },
  ];

  const pages = buildReaderPages(segments, 120, 0, [], 1);

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

  const pages = buildReaderPages(segments, 45, 2, [], 1);

  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((page) => [page.startLocation.textOffset, page.endLocation.textOffset]), [[0, 21], [21, 42]]);
  assert.equal(readerPageIndexForLocation(pages, { chapterIndex: 2, blockIndex: 3, textOffset: 21 }), 1);
  assert.equal(readerPageIndexForLocation(pages, { chapterIndex: 3, blockIndex: 3, textOffset: 21 }), null);
});

test('preceding pages pack backward from the anchor while keeping adjacent offsets', () => {
  const segments: ReaderPaginationSegment[] = [
    { kind: 'text-line', blockIndex: 2, startOffset: 20, endOffset: 30, startY: 40, endY: 58 },
    { kind: 'text-line', blockIndex: 2, startOffset: 30, endOffset: 40, startY: 60, endY: 78 },
    { kind: 'text-line', blockIndex: 2, startOffset: 40, endOffset: 50, startY: 80, endY: 98 },
    { kind: 'text-line', blockIndex: 2, startOffset: 50, endOffset: 60, startY: 100, endY: 118 },
    { kind: 'text-line', blockIndex: 2, startOffset: 60, endOffset: 70, startY: 120, endY: 138 },
  ];

  const forwardPages = buildReaderPages(segments, 42, 1, [], 1);
  const previousPages = buildPreviousReaderPages(segments, 42, 1, [], 1);
  const anchorPage = buildReaderPages([{
    kind: 'text-line',
    blockIndex: 2,
    startOffset: 70,
    endOffset: 80,
    startY: 140,
    endY: 158,
  }], 42, 1, [], 1)[0];

  assert.deepEqual(forwardPages.map((page) => [page.startLocation.textOffset, page.endLocation.textOffset]), [
    [20, 40],
    [40, 60],
    [60, 70],
  ]);
  assert.deepEqual(previousPages.map((page) => [page.startLocation.textOffset, page.endLocation.textOffset]), [
    [20, 30],
    [30, 50],
    [50, 70],
  ]);
  assert.deepEqual(previousPages.slice(1).map((page) => page.endLocation.textOffset), [
    previousPages[2]?.startLocation.textOffset,
    70,
  ]);
  const nearestPreviousPage = previousPages.at(-1);
  assert.ok(nearestPreviousPage);
  assert.ok(nearestPreviousPage.endY - nearestPreviousPage.startY <= 42);
  assert.ok(anchorPage);
  assert.deepEqual(nearestPreviousPage.endLocation, anchorPage.startLocation);
});

test('backward packing reserves deduplicated card groups and retains source geometry', () => {
  const segments: ReaderPaginationSegment[] = [
    {
      kind: 'atomic',
      blockIndex: 4,
      startOffset: 0,
      endOffset: 0,
      startY: 0,
      endY: 28,
      blockTopY: -4,
      blockBottomY: 110,
    },
    {
      kind: 'text-line',
      blockIndex: 4,
      startOffset: 0,
      endOffset: 10,
      startY: 30,
      endY: 48,
      blockTopY: -4,
      blockBottomY: 110,
      selectedTargetKeys: ['target-a'],
    },
    {
      kind: 'text-line',
      blockIndex: 4,
      startOffset: 10,
      endOffset: 20,
      startY: 50,
      endY: 68,
      blockTopY: -4,
      blockBottomY: 110,
      selectedTargetKeys: ['target-a', 'target-b'],
    },
    {
      kind: 'text-line',
      blockIndex: 4,
      startOffset: 20,
      endOffset: 30,
      startY: 70,
      endY: 88,
      blockTopY: -4,
      blockBottomY: 110,
      selectedTargetKeys: ['target-a'],
    },
  ];
  const cardMetrics: ReaderPaginationCardMetric[] = [
    { targetKey: 'target-a', height: 40 },
    { targetKey: 'target-b', height: 60 },
  ];

  const pages = buildPreviousReaderPages(segments, 110, 1, cardMetrics, 2);
  const forwardPages = buildReaderPages(segments, 110, 1, cardMetrics, 2);
  const nearestPage = pages.at(-1);
  const matchingForwardPage = forwardPages.find((page) => (
    page.startLocation.blockIndex === nearestPage?.startLocation.blockIndex
    && page.startLocation.textOffset === nearestPage.startLocation.textOffset
    && page.endLocation.blockIndex === nearestPage.endLocation.blockIndex
    && page.endLocation.textOffset === nearestPage.endLocation.textOffset
  ));

  assert.ok(nearestPage);
  assert.equal(nearestPage.startLocation.textOffset, 10);
  assert.equal(nearestPage.endLocation.textOffset, 30);
  assert.deepEqual(nearestPage.cardGroups.map((group) => [group.targetKeys, group.reservedHeight]), [
    [['target-a', 'target-b'], 60],
  ]);
  assert.equal(nearestPage.reservedCardHeight, 68);
  assert.ok(nearestPage.presentationHeight <= 110);
  assert.ok(matchingForwardPage);
  assert.deepEqual({
    cardTargetKeys: nearestPage.cardTargetKeys,
    cardGroups: nearestPage.cardGroups,
    blockDisplayOffsets: nearestPage.blockDisplayOffsets,
    blockFragments: nearestPage.blockFragments,
    textClipHeight: nearestPage.textClipHeight,
    presentationHeight: nearestPage.presentationHeight,
  }, {
    cardTargetKeys: matchingForwardPage.cardTargetKeys,
    cardGroups: matchingForwardPage.cardGroups,
    blockDisplayOffsets: matchingForwardPage.blockDisplayOffsets,
    blockFragments: matchingForwardPage.blockFragments,
    textClipHeight: matchingForwardPage.textClipHeight,
    presentationHeight: matchingForwardPage.presentationHeight,
  });
  assert.deepEqual(pages[0]?.issues, []);
  assert.equal(pages[0]?.blockFragments[0]?.blockTopY, -4);
  assert.equal(pages[0]?.blockFragments[0]?.blockBottomY, 110);
  assert.equal(pages[0]?.startLocation.textOffset, 0);
  assert.equal(pages[0]?.blockFragments[0]?.startY, 0);
});

test('a selected word at the bottom of a page moves with its card tray', () => {
  const segments: ReaderPaginationSegment[] = [
    { kind: 'text-line', blockIndex: 0, startOffset: 0, endOffset: 10, startY: 0, endY: 18 },
    { kind: 'text-line', blockIndex: 0, startOffset: 10, endOffset: 20, startY: 20, endY: 38 },
    { kind: 'text-line', blockIndex: 0, startOffset: 20, endOffset: 30, startY: 40, endY: 58 },
    { kind: 'text-line', blockIndex: 0, startOffset: 30, endOffset: 40, startY: 60, endY: 78 },
    { kind: 'text-line', blockIndex: 0, startOffset: 40, endOffset: 50, startY: 80, endY: 98, selectedTargetKeys: ['target-a'] },
  ];

  const pages = buildReaderPages(segments, 100, 0, [{ targetKey: 'target-a', height: 20 }], 1);

  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((page) => [page.startLocation.textOffset, page.endLocation.textOffset]), [[0, 40], [40, 50]]);
  assert.deepEqual(pages.map((page) => page.cardTargetKeys), [[], ['target-a']]);
  assert.equal(pages[1].reservedCardHeight, 28);
  assert.deepEqual(pages.map((page) => [page.startY, page.endY]), [[0, 78], [80, 98]]);
});

test('selected targets belong to each page containing their lines across paragraph splits', () => {
  const segments: ReaderPaginationSegment[] = [
    { kind: 'text-line', blockIndex: 5, startOffset: 0, endOffset: 10, startY: 0, endY: 18, selectedTargetKeys: ['target-a'] },
    { kind: 'text-line', blockIndex: 5, startOffset: 10, endOffset: 20, startY: 20, endY: 38, selectedTargetKeys: ['target-b'] },
    { kind: 'text-line', blockIndex: 5, startOffset: 20, endOffset: 30, startY: 40, endY: 58, selectedTargetKeys: ['target-a'] },
    { kind: 'text-line', blockIndex: 5, startOffset: 30, endOffset: 40, startY: 60, endY: 78 },
    { kind: 'text-line', blockIndex: 5, startOffset: 40, endOffset: 50, startY: 80, endY: 98, selectedTargetKeys: ['target-b'] },
    { kind: 'text-line', blockIndex: 5, startOffset: 50, endOffset: 60, startY: 100, endY: 118 },
    { kind: 'text-line', blockIndex: 5, startOffset: 60, endOffset: 70, startY: 120, endY: 138, selectedTargetKeys: ['target-a'] },
    { kind: 'text-line', blockIndex: 5, startOffset: 70, endOffset: 80, startY: 140, endY: 158, selectedTargetKeys: ['target-b'] },
  ];

  const pages = buildReaderPages(segments, 110, 0, [
    { targetKey: 'target-a', height: 8 },
    { targetKey: 'target-b', height: 8 },
  ], 1);

  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((page) => [page.startLocation.textOffset, page.endLocation.textOffset]), [[0, 30], [30, 60], [60, 80]]);
  assert.deepEqual(pages.map((page) => page.cardTargetKeys), [['target-a', 'target-b'], ['target-b'], ['target-a', 'target-b']]);
  assert.deepEqual(pages.map((page) => page.reservedCardHeight), [36, 16, 36]);
  assert.deepEqual(pages.map((page) => page.cardGroups.map((group) => [group.blockIndex, group.targetKeys])), [
    [[5, ['target-a', 'target-b']]],
    [[5, ['target-b']]],
    [[5, ['target-a', 'target-b']]],
  ]);
  segments.forEach((segment) => {
    const page = pages.find((candidate) => (
      candidate.startLocation.textOffset <= segment.startOffset
      && candidate.endLocation.textOffset >= segment.endOffset
    ));
    assert.ok(page, `No page contains segment offsets ${segment.startOffset}-${segment.endOffset}`);
    segment.selectedTargetKeys?.forEach((targetKey) => {
      assert.ok(page.cardTargetKeys.includes(targetKey), `Page for ${segment.startOffset}-${segment.endOffset} is missing ${targetKey}`);
    });
  });
});

test('separate paragraph card groups stay with their blocks and both consume page height', () => {
  const segments: ReaderPaginationSegment[] = [
    { kind: 'text-line', blockIndex: 0, startOffset: 0, endOffset: 10, startY: 0, endY: 18, selectedTargetKeys: ['target-a'] },
    { kind: 'text-line', blockIndex: 0, startOffset: 10, endOffset: 20, startY: 20, endY: 38 },
    { kind: 'text-line', blockIndex: 1, startOffset: 0, endOffset: 10, startY: 40, endY: 58, selectedTargetKeys: ['target-b'] },
    { kind: 'text-line', blockIndex: 1, startOffset: 10, endOffset: 20, startY: 60, endY: 78, selectedTargetKeys: ['target-b'] },
  ];

  const pages = buildReaderPages(segments, 250, 0, [
    { targetKey: 'target-a', height: 80 },
    { targetKey: 'target-b', height: 80 },
  ], 1);

  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].cardGroups.map((group) => [group.blockIndex, group.targetKeys]), [
    [0, ['target-a']],
    [1, ['target-b']],
  ]);
  assert.equal(pages[0].reservedCardHeight, 176);
  assert.deepEqual(pages.map((page) => [page.startLocation.blockIndex, page.startLocation.textOffset, page.endLocation.blockIndex, page.endLocation.textOffset]), [
    [0, 0, 1, 10],
    [1, 10, 1, 20],
  ]);
  assert.deepEqual(pages[1].cardGroups.map((group) => [group.blockIndex, group.targetKeys]), [[1, ['target-b']]]);
  assert.ok(pages[0].presentationHeight <= 250);

  const firstPage = pages[0];
  const blockOffsets = new Map(firstPage.blockDisplayOffsets.map(({ blockIndex, offset }) => [blockIndex, offset]));
  const firstBlockFragment = firstPage.blockFragments.filter((fragment) => fragment.blockIndex === 0).at(-1);
  const secondBlockFragment = firstPage.blockFragments.find((fragment) => fragment.blockIndex === 1);
  assert.ok(firstBlockFragment);
  assert.ok(secondBlockFragment);
  assert.ok(firstPage.cardGroups[0].topOffset >= firstBlockFragment.endY - firstPage.startY + (blockOffsets.get(0) ?? 0));
  assert.ok(firstPage.cardGroups[0].topOffset < secondBlockFragment.startY - firstPage.startY + (blockOffsets.get(1) ?? 0));
  assert.ok(firstPage.cardGroups[1].topOffset >= secondBlockFragment.endY - firstPage.startY + (blockOffsets.get(1) ?? 0));
});

test('card rows follow rendered metric order when selected segments occur in another order', () => {
  const segments: ReaderPaginationSegment[] = [
    {
      kind: 'text-line',
      blockIndex: 0,
      startOffset: 0,
      endOffset: 10,
      startY: 0,
      endY: 30,
      selectedTargetKeys: ['target-c', 'target-a', 'target-b'],
    },
    { kind: 'text-line', blockIndex: 0, startOffset: 10, endOffset: 20, startY: 32, endY: 42 },
  ];
  const metrics: ReaderPaginationCardMetric[] = [
    { targetKey: 'target-a', height: 40 },
    { targetKey: 'target-b', height: 30 },
    { targetKey: 'target-c', height: 100 },
  ];

  const pages = buildReaderPages(segments, 195, 0, metrics, 2);

  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].cardGroups.map((group) => group.targetKeys), [
    ['target-a', 'target-b', 'target-c'],
  ]);
  assert.equal(pages[0].cardGroups[0].reservedHeight, 152);
  assert.equal(pages[0].reservedCardHeight, 160);
  assert.equal(pages[0].presentationHeight, 190);
  assert.equal(pages[0].endLocation.textOffset, 10);
  assert.deepEqual(pages[1].cardTargetKeys, []);
});

test('selected-card reservation uses measured heights without a 240-pixel clamp', () => {
  const segment: ReaderPaginationSegment = {
    kind: 'text-line',
    blockIndex: 0,
    startOffset: 0,
    endOffset: 10,
    startY: 0,
    endY: 18,
    selectedTargetKeys: ['target-a'],
  };

  const shortPage = buildReaderPages([segment], 200, 0, [{ targetKey: 'target-a', height: 70 }], 1);
  const tallPage = buildReaderPages([segment], 1000, 0, [{ targetKey: 'target-a', height: 250 }], 1);

  assert.equal(shortPage[0].reservedCardHeight, 78);
  assert.equal(tallPage[0].reservedCardHeight, 258);
  assert.deepEqual(tallPage[0].cardTargetKeys, ['target-a']);
});

test('equal canonical page starts restore to the earliest title or card-only page', () => {
  const segments: ReaderPaginationSegment[] = [
    { kind: 'atomic', blockIndex: 0, startOffset: 0, endOffset: 0, startY: 0, endY: 60 },
    { kind: 'text-line', blockIndex: 0, startOffset: 0, endOffset: 8, startY: 64, endY: 82 },
    { kind: 'atomic', blockIndex: 0, startOffset: 8, endOffset: 8, startY: 86, endY: 146 },
    { kind: 'atomic', blockIndex: 0, startOffset: 8, endOffset: 8, startY: 150, endY: 210 },
  ];

  const pages = buildReaderPages(segments, 70, 0, [], 1);

  assert.equal(readerPageIndexForLocation(pages, { chapterIndex: 0, blockIndex: 0, textOffset: 0 }), 0);
  assert.equal(readerPageIndexForLocation(pages, { chapterIndex: 0, blockIndex: 0, textOffset: 8 }), 2);
  assert.deepEqual(pages.map((page) => page.startLocation.textOffset), [0, 0, 8, 8]);
});

test('oversized visual segments are surfaced as a page issue', () => {
  const segments: ReaderPaginationSegment[] = [
    { kind: 'atomic', blockIndex: 4, startOffset: 0, endOffset: 0, startY: 10, endY: 160 },
  ];

  const pages = buildReaderPages(segments, 100, 1, [], 1);

  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].issues, [{
    type: 'oversized-segment',
    blockIndex: 4,
    segmentKind: 'atomic',
    segmentHeight: 150,
    pageHeight: 100,
  }]);
});
