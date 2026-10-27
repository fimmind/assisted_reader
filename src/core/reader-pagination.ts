import type { ReaderLocation } from './types';

export interface ReaderPaginationSegment {
  startY: number;
  endY: number;
  blockIndex: number;
  startOffset: number;
  endOffset: number;
  kind: 'text-line' | 'atomic';
  selectedTargetKeys?: readonly string[];
  blockTopY?: number;
  blockBottomY?: number;
}

export interface ReaderPaginationCardGroup {
  blockIndex: number;
  targetKeys: string[];
  topOffset: number;
  reservedHeight: number;
}

export interface ReaderPaginationCardMetric {
  targetKey: string;
  height: number;
}

export interface ReaderPaginationBlockFragment {
  blockIndex: number;
  startY: number;
  endY: number;
  startOffset: number;
  endOffset: number;
  blockTopY: number;
  blockBottomY: number;
  displayOffset: number;
}

export interface ReaderPaginationPage {
  startY: number;
  endY: number;
  startLocation: ReaderLocation;
  endLocation: ReaderLocation;
  issues: ReaderPaginationIssue[];
  cardTargetKeys: string[];
  reservedCardHeight: number;
  cardGroups: ReaderPaginationCardGroup[];
  blockDisplayOffsets: { blockIndex: number; offset: number }[];
  blockFragments: ReaderPaginationBlockFragment[];
  textClipHeight: number;
  presentationHeight: number;
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
  hasPreviousPages?: boolean;
  hasNextPages?: boolean;
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

function buildReaderPagesInInputOrder(
  segments: readonly ReaderPaginationSegment[],
  pageHeight: number,
  chapterIndex: number,
  cardMetrics: readonly ReaderPaginationCardMetric[],
  cardColumnCapacity: number,
): ReaderPaginationPage[] {
  if (!Number.isFinite(pageHeight) || pageHeight <= 0) {
    throw new RangeError(`Reader pagination page height must be positive: pageHeight=${pageHeight}`);
  }
  if (!Number.isInteger(chapterIndex) || chapterIndex < 0) {
    throw new RangeError(`Reader pagination chapter index must be non-negative: chapterIndex=${chapterIndex}`);
  }
  if (!Number.isInteger(cardColumnCapacity) || cardColumnCapacity < 1) {
    throw new RangeError(`Reader pagination card column capacity must be positive: cardColumnCapacity=${cardColumnCapacity}`);
  }
  segments.forEach(validateSegment);
  const cardHeightByTarget = new Map<string, number>();
  const cardOrderByTarget = new Map<string, number>();
  cardMetrics.forEach((metric) => {
    if (metric.targetKey.length === 0 || !Number.isFinite(metric.height) || metric.height <= 0) {
      throw new RangeError(`Reader pagination card metric is invalid: targetKey=${metric.targetKey}, height=${metric.height}`);
    }
    if (cardHeightByTarget.has(metric.targetKey)) {
      throw new RangeError(`Reader pagination card metric is duplicated: targetKey=${metric.targetKey}`);
    }
    cardHeightByTarget.set(metric.targetKey, metric.height);
    cardOrderByTarget.set(metric.targetKey, cardOrderByTarget.size);
  });

  const pages: ReaderPaginationPage[] = [];
  let pageSegments: ReaderPaginationSegment[] = [];
  let pageIssues: ReaderPaginationIssue[] = [];
  let pageCardTargetsByBlock = new Map<number, Set<string>>();
  let pageStartY: number | null = null;
  let pageEndY: number | null = null;
  const paragraphCardGap = 8;
  const cardRowGap = 12;
  const cardGroupHeight = (targetKeys: ReadonlySet<string>): number => {
    const orderedKeys = [...targetKeys].sort((left, right) => {
      const leftOrder = cardOrderByTarget.get(left);
      const rightOrder = cardOrderByTarget.get(right);
      if (leftOrder === undefined || rightOrder === undefined) {
        throw new RangeError(`Reader pagination card order is missing: left=${left}, right=${right}`);
      }
      return leftOrder - rightOrder;
    });
    if (orderedKeys.length === 0) return 0;
    const rowHeights: number[] = [];
    for (let index = 0; index < orderedKeys.length; index += cardColumnCapacity) {
      const rowKeys = orderedKeys.slice(index, index + cardColumnCapacity);
      const rowHeight = rowKeys.reduce((maximum, targetKey) => {
        const height = cardHeightByTarget.get(targetKey);
        if (height === undefined) {
          throw new RangeError(`Reader pagination card height is missing: targetKey=${targetKey}`);
        }
        return Math.max(maximum, height);
      }, 0);
      rowHeights.push(rowHeight);
    }
    return rowHeights.reduce((total, height) => total + height, 0)
      + Math.max(0, rowHeights.length - 1) * cardRowGap;
  };
  const pageReservedHeight = (targetsByBlock: ReadonlyMap<number, ReadonlySet<string>>): number =>
    [...targetsByBlock.values()].reduce((total, targetKeys) =>
      total + (targetKeys.size > 0 ? cardGroupHeight(targetKeys) + paragraphCardGap : 0), 0);

  const finishPage = (): void => {
    const orderedPageSegments = [...pageSegments].sort((left, right) =>
      left.startY - right.startY
      || left.endY - right.endY
      || left.blockIndex - right.blockIndex
      || left.startOffset - right.startOffset);
    const first = orderedPageSegments[0];
    const last = orderedPageSegments[orderedPageSegments.length - 1];
    if (!first || !last) return;
    const blockIndices = [...new Set(orderedPageSegments.map((segment) => segment.blockIndex))];
    const groupBlocks = blockIndices.filter((blockIndex) => (pageCardTargetsByBlock.get(blockIndex)?.size ?? 0) > 0);
    const groupHeights = new Map(groupBlocks.map((blockIndex) => {
      const targets = pageCardTargetsByBlock.get(blockIndex);
      if (!targets) throw new Error(`Reader pagination card group targets are missing: blockIndex=${blockIndex}`);
      return [blockIndex, cardGroupHeight(targets)] as const;
    }));
    const displayOffsetByBlock = new Map<number, number>();
    let accumulatedDisplayOffset = 0;
    blockIndices.forEach((blockIndex) => {
      displayOffsetByBlock.set(blockIndex, accumulatedDisplayOffset);
      const groupHeight = groupHeights.get(blockIndex);
      if (groupHeight !== undefined) accumulatedDisplayOffset += groupHeight + paragraphCardGap;
    });
    const blockDisplayOffsets = blockIndices.map((blockIndex) => ({
      blockIndex,
      offset: displayOffsetByBlock.get(blockIndex) ?? 0,
    }));
    const blockFragments = blockIndices.map((blockIndex) => {
      const blockSegments = orderedPageSegments.filter((segment) => segment.blockIndex === blockIndex);
      const firstBlockSegment = blockSegments[0];
      const lastBlockSegment = blockSegments[blockSegments.length - 1];
      if (!firstBlockSegment || !lastBlockSegment) {
        throw new Error(`Reader pagination page has no segment for block ${blockIndex}.`);
      }
      const firstSegmentTop = Math.min(...blockSegments.map((segment) => segment.startY));
      const lastSegmentBottom = Math.max(...blockSegments.map((segment) => segment.endY));
      const fragmentOffset = blockDisplayOffsets.find((entry) => entry.blockIndex === blockIndex)?.offset ?? 0;
      return {
        blockIndex,
        startY: firstSegmentTop,
        endY: lastSegmentBottom,
        startOffset: Math.min(...blockSegments.map((segment) => segment.startOffset)),
        endOffset: Math.max(...blockSegments.map((segment) => segment.endOffset)),
        blockTopY: Math.min(...blockSegments.map((segment) => segment.blockTopY ?? segment.startY)),
        blockBottomY: Math.max(...blockSegments.map((segment) => segment.blockBottomY ?? segment.endY)),
        displayOffset: fragmentOffset,
      };
    });
    const cardGroups = groupBlocks.map((blockIndex) => {
      const blockFragment = blockFragments.find((fragment) => fragment.blockIndex === blockIndex);
      const reservedHeight = groupHeights.get(blockIndex);
      if (reservedHeight === undefined || !blockFragment) {
        throw new Error(`Reader pagination card group has no measured fragment for block ${blockIndex}.`);
      }
      return {
        blockIndex,
        targetKeys: [...(pageCardTargetsByBlock.get(blockIndex) ?? [])].sort((left, right) => {
          const leftOrder = cardOrderByTarget.get(left);
          const rightOrder = cardOrderByTarget.get(right);
          if (leftOrder === undefined || rightOrder === undefined) {
            throw new RangeError(`Reader pagination card order is missing: left=${left}, right=${right}`);
          }
          return leftOrder - rightOrder;
        }),
        topOffset: blockFragment.endY - first.startY + blockFragment.displayOffset + paragraphCardGap,
        reservedHeight,
      };
    });
    const orderedCardTargetsByBlock = new Map<number, Set<string>>();
    orderedPageSegments.forEach((segment) => {
      const targetKeys = orderedCardTargetsByBlock.get(segment.blockIndex) ?? new Set<string>();
      segment.selectedTargetKeys?.forEach((targetKey) => targetKeys.add(targetKey));
      orderedCardTargetsByBlock.set(segment.blockIndex, targetKeys);
    });
    const cardTargetKeys = blockIndices.flatMap((blockIndex) => [
      ...(orderedCardTargetsByBlock.get(blockIndex) ?? []),
    ]);
    const reservedHeight = pageReservedHeight(pageCardTargetsByBlock);
    const textClipHeight = Math.max(...blockFragments.map((fragment) =>
      fragment.endY - first.startY + fragment.displayOffset));
    const presentationHeight = Math.max(
      textClipHeight,
      ...cardGroups.map((group) => group.topOffset + group.reservedHeight),
    );
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
      cardTargetKeys,
      reservedCardHeight: reservedHeight,
      cardGroups,
      blockDisplayOffsets,
      blockFragments,
      textClipHeight,
      presentationHeight,
    });
    pageSegments = [];
    pageIssues = [];
    pageCardTargetsByBlock = new Map<number, Set<string>>();
    pageStartY = null;
    pageEndY = null;
  };

  segments.forEach((segment) => {
    const nextTargetsByBlock = new Map([...pageCardTargetsByBlock].map(([blockIndex, targetKeys]) => [blockIndex, new Set(targetKeys)]));
    if (segment.selectedTargetKeys?.length) {
      const targetKeys = nextTargetsByBlock.get(segment.blockIndex) ?? new Set<string>();
      segment.selectedTargetKeys.forEach((targetKey) => targetKeys.add(targetKey));
      nextTargetsByBlock.set(segment.blockIndex, targetKeys);
    }
    const projectedReservedHeight = pageReservedHeight(nextTargetsByBlock);
    const projectedStartY = pageStartY === null ? segment.startY : Math.min(pageStartY, segment.startY);
    const projectedEndY = pageEndY === null ? segment.endY : Math.max(pageEndY, segment.endY);
    if (pageSegments.length > 0 && projectedEndY - projectedStartY + projectedReservedHeight > pageHeight) {
      finishPage();
    }
    pageSegments.push(segment);
    pageStartY = pageStartY === null ? segment.startY : Math.min(pageStartY, segment.startY);
    pageEndY = pageEndY === null ? segment.endY : Math.max(pageEndY, segment.endY);
    if (segment.selectedTargetKeys?.length) {
      const targetKeys = pageCardTargetsByBlock.get(segment.blockIndex) ?? new Set<string>();
      segment.selectedTargetKeys.forEach((targetKey) => targetKeys.add(targetKey));
      pageCardTargetsByBlock.set(segment.blockIndex, targetKeys);
    }
    const segmentHeight = segment.endY - segment.startY;
    const reservedHeight = pageReservedHeight(pageCardTargetsByBlock);
    if (segmentHeight + reservedHeight > pageHeight) {
      pageIssues.push({
        type: 'oversized-segment',
        blockIndex: segment.blockIndex,
        segmentKind: segment.kind,
        segmentHeight: segmentHeight + reservedHeight,
        pageHeight,
      });
      finishPage();
    }
  });
  finishPage();

  return pages;
}

/** Pack measured lines into pages while reserving measured selected-word card groups. */
export function buildReaderPages(
  segments: readonly ReaderPaginationSegment[],
  pageHeight: number,
  chapterIndex: number,
  cardMetrics: readonly ReaderPaginationCardMetric[],
  cardColumnCapacity: number,
): ReaderPaginationPage[] {
  const orderedSegments = [...segments].sort((left, right) =>
    left.startY - right.startY
    || left.endY - right.endY
    || left.blockIndex - right.blockIndex
    || left.startOffset - right.startOffset);
  return buildReaderPagesInInputOrder(orderedSegments, pageHeight, chapterIndex, cardMetrics, cardColumnCapacity);
}

/** Pack preceding measured lines backward from the anchor to keep the nearest page full. */
export function buildPreviousReaderPages(
  segments: readonly ReaderPaginationSegment[],
  pageHeight: number,
  chapterIndex: number,
  cardMetrics: readonly ReaderPaginationCardMetric[],
  cardColumnCapacity: number,
): ReaderPaginationPage[] {
  const reverseOrderedSegments = [...segments].sort((left, right) =>
    right.startY - left.startY
    || right.endY - left.endY
    || right.blockIndex - left.blockIndex
    || right.startOffset - left.startOffset);
  return buildReaderPagesInInputOrder(reverseOrderedSegments, pageHeight, chapterIndex, cardMetrics, cardColumnCapacity).reverse();
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
