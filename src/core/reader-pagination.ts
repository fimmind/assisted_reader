import type { ReaderLocation } from './types';

export interface ReaderPaginationSegment {
  startY: number;
  endY: number;
  blockIndex: number;
  startOffset: number;
  endOffset: number;
  kind: 'text-line' | 'atomic';
}

export interface ReaderPaginationPage {
  startY: number;
  endY: number;
  startLocation: ReaderLocation;
  endLocation: ReaderLocation;
  issues: ReaderPaginationIssue[];
}

export interface ReaderPaginationIssue {
  type: 'oversized-segment';
  blockIndex: number;
  segmentKind: ReaderPaginationSegment['kind'];
  segmentHeight: number;
  pageHeight: number;
}

export interface ReaderPaginationLayout {
  chapterIndex: number;
  layoutKey: string;
  signature: string;
  pageHeight: number;
  pages: ReaderPaginationPage[];
}

function compareLocations(left: ReaderLocation, right: ReaderLocation): number {
  if (left.chapterIndex !== right.chapterIndex) return left.chapterIndex - right.chapterIndex;
  if (left.blockIndex !== right.blockIndex) return left.blockIndex - right.blockIndex;
  return left.textOffset - right.textOffset;
}

function validateSegment(segment: ReaderPaginationSegment): void {
  if (!Number.isFinite(segment.startY) || !Number.isFinite(segment.endY) || segment.endY < segment.startY) {
    throw new RangeError(`Reader pagination segment has invalid vertical bounds: startY=${segment.startY}, endY=${segment.endY}`);
  }
  if (!Number.isInteger(segment.blockIndex) || segment.blockIndex < 0) {
    throw new RangeError(`Reader pagination segment has invalid block index: blockIndex=${segment.blockIndex}`);
  }
  if (!Number.isInteger(segment.startOffset) || !Number.isInteger(segment.endOffset)
    || segment.startOffset < 0 || segment.endOffset < segment.startOffset) {
    throw new RangeError(`Reader pagination segment has invalid text offsets: startOffset=${segment.startOffset}, endOffset=${segment.endOffset}`);
  }
}

/** Pack measured text lines and atomic visual rows into pages without cutting a segment. */
export function buildReaderPages(
  segments: readonly ReaderPaginationSegment[],
  pageHeight: number,
  chapterIndex: number,
): ReaderPaginationPage[] {
  if (!Number.isFinite(pageHeight) || pageHeight <= 0) {
    throw new RangeError(`Reader pagination page height must be positive: pageHeight=${pageHeight}`);
  }
  if (!Number.isInteger(chapterIndex) || chapterIndex < 0) {
    throw new RangeError(`Reader pagination chapter index must be non-negative: chapterIndex=${chapterIndex}`);
  }
  segments.forEach(validateSegment);

  const orderedSegments = [...segments].sort((left, right) =>
    left.startY - right.startY
    || left.endY - right.endY
    || left.blockIndex - right.blockIndex
    || left.startOffset - right.startOffset);
  const pages: ReaderPaginationPage[] = [];
  let pageSegments: ReaderPaginationSegment[] = [];
  let pageIssues: ReaderPaginationIssue[] = [];

  const finishPage = (): void => {
    const first = pageSegments[0];
    const last = pageSegments[pageSegments.length - 1];
    if (!first || !last) return;
    pages.push({
      startY: first.startY,
      endY: last.endY,
      startLocation: {
        chapterIndex,
        blockIndex: first.blockIndex,
        textOffset: first.startOffset,
      },
      endLocation: {
        chapterIndex,
        blockIndex: last.blockIndex,
        textOffset: last.endOffset,
      },
      issues: pageIssues,
    });
    pageSegments = [];
    pageIssues = [];
  };

  orderedSegments.forEach((segment) => {
    const first = pageSegments[0];
    if (first && segment.endY - first.startY > pageHeight) {
      finishPage();
    }
    pageSegments.push(segment);
    const segmentHeight = segment.endY - segment.startY;
    if (segmentHeight > pageHeight) {
      pageIssues.push({
        type: 'oversized-segment',
        blockIndex: segment.blockIndex,
        segmentKind: segment.kind,
        segmentHeight,
        pageHeight,
      });
      finishPage();
    }
  });
  finishPage();

  return pages;
}

/** Find the page at or immediately before a canonical reader location. */
export function readerPageIndexForLocation(
  pages: readonly ReaderPaginationPage[],
  location: ReaderLocation,
): number | null {
  if (!Number.isInteger(location.chapterIndex) || location.chapterIndex < 0
    || !Number.isInteger(location.blockIndex) || location.blockIndex < 0
    || !Number.isInteger(location.textOffset) || location.textOffset < 0) {
    throw new RangeError(`Reader location is invalid: chapterIndex=${location.chapterIndex}, blockIndex=${location.blockIndex}, textOffset=${location.textOffset}`);
  }
  if (pages.length === 0 || pages[0].startLocation.chapterIndex !== location.chapterIndex) return null;
  let matchingPageIndex: number | null = null;
  for (let index = 0; index < pages.length; index += 1) {
    const comparison = compareLocations(pages[index].startLocation, location);
    if (comparison > 0) break;
    if (comparison < 0) {
      matchingPageIndex = index;
      continue;
    }
    const previousPage = pages[index - 1];
    if (!previousPage || compareLocations(previousPage.startLocation, location) !== 0) {
      matchingPageIndex = index;
    }
  }
  return matchingPageIndex;
}
