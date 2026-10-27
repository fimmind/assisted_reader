import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  buildReaderPages,
  type ReaderPaginationCardMetric,
  type ReaderPaginationLayout,
  type ReaderPaginationPage,
  type ReaderPaginationSegment,
} from '@/core/reader-pagination';
import type { ReaderLocation } from '@/core/types';

interface UseReaderPaginationOptions {
  rootRef: RefObject<HTMLElement | null>;
  initialLayout: ReaderPaginationLayout | null;
  enabled: boolean;
  settled: boolean;
  getMeasurementKey: (layout: ReaderPaginationLayout | null) => string | null;
  layoutKey: string;
  chapterIndex: number;
  pageHeight: number;
  anchor: ReaderLocation | null;
}

interface ReaderPaginationErrorState {
  layoutKey: string;
  error: Error;
}

export interface UseReaderPaginationResult {
  layout: ReaderPaginationLayout | null;
  isReady: boolean;
  error: Error | null;
  settledMeasurementRevision: number;
  measuredMeasurementKey: string | null;
  requestBoundaryPage: (direction: 'previous' | 'next') => void;
}

interface BoundaryPageRequest {
  direction: 'previous' | 'next';
  anchor: ReaderLocation;
}

function readAnchorPage(
  root: HTMLElement,
  pageHeight: number,
  chapterIndex: number,
  anchor: ReaderLocation | null,
  cardColumnCapacity: number,
  endBoundary: ReaderLocation | null,
): ReaderPaginationPage | null {
  const markedBlocks = Array.from(root.querySelectorAll<HTMLElement>('[data-reader-block-index]'));
  const targetBlock = anchor
    ? markedBlocks.find((element) => Number(element.dataset.readerBlockIndex) === anchor.blockIndex)
    : markedBlocks[0];
  if (!targetBlock) return null;

  const blockIndex = Number(targetBlock.dataset.readerBlockIndex);
  const rootTop = root.getBoundingClientRect().top;
  const targetBlockIndex = markedBlocks.indexOf(targetBlock);
  const targetText = targetBlock.querySelector<HTMLElement>('[data-reader-text-block], .reader-text');
  const anchorOffset = anchor && anchor.chapterIndex === chapterIndex && anchor.blockIndex === blockIndex
    ? anchor.textOffset
    : 0;
  const anchorBounds = targetText ? textBoundsAtOffset(targetText, anchorOffset) : null;
  const targetPresentationOffset = Number(targetBlock.dataset.readerPaginationOffset ?? '0');
  const anchorY = anchorBounds
    ? anchorBounds.top - rootTop - targetPresentationOffset
    : targetBlock.getBoundingClientRect().top - rootTop - targetPresentationOffset;
  const startsAtChapterOpening = !anchor
    || (anchor.chapterIndex === chapterIndex && anchor.blockIndex === 0 && anchor.textOffset === 0);
  const measurementRange = {
    top: startsAtChapterOpening ? 0 : anchorY - PAGE_EDGE_EPSILON * 2,
    bottom: anchorY + pageHeight * 1.5,
  };
  const segments: ReaderPaginationSegment[] = [];
  if (startsAtChapterOpening && targetBlockIndex === 0) {
    segments.push(...leadingPreambleSegments(root, targetBlock, blockIndex, rootTop)
      .filter((segment) => segment.endY >= measurementRange.top && segment.startY <= measurementRange.bottom));
  }
  let firstSegmentIndex = 0;
  let pageStartY: number | null = null;
  let pageEndY: number | null = null;
  for (const [elementIndex, element] of markedBlocks.entries()) {
    if (elementIndex < targetBlockIndex) continue;
    const currentBlockIndex = Number(element.dataset.readerBlockIndex);
    if (endBoundary && currentBlockIndex > endBoundary.blockIndex) break;
    const blockOffset = Number(element.dataset.readerPaginationOffset ?? '0');
    const bounds = rectBounds(element, rootTop, blockOffset);
    if (bounds.top > measurementRange.bottom) break;
    if (bounds.bottom < measurementRange.top) continue;
    const blockSegments = measuredBlockSegments(element, rootTop, currentBlockIndex, measurementRange);
    if (elementIndex === targetBlockIndex) {
      const targetSegmentIndex = anchor && anchor.chapterIndex === chapterIndex && anchor.blockIndex === blockIndex
        ? blockSegments.findIndex((segment) => segment.endOffset > anchor.textOffset
          || (segment.kind === 'atomic' && segment.startOffset >= anchor.textOffset))
        : 0;
      firstSegmentIndex = targetSegmentIndex >= 0
        ? targetSegmentIndex
        : Math.max(0, blockSegments.length - 1);
    }
    const remainingSegments = elementIndex === targetBlockIndex
      ? blockSegments.slice(firstSegmentIndex)
      : blockSegments;
    const boundedSegments = endBoundary ? remainingSegments.filter((segment) =>
      segment.blockIndex < endBoundary.blockIndex
      || (segment.blockIndex === endBoundary.blockIndex && segment.endOffset <= endBoundary.textOffset))
      : remainingSegments;
    segments.push(...boundedSegments);
    boundedSegments.forEach((segment) => {
      pageStartY = pageStartY === null ? segment.startY : Math.min(pageStartY, segment.startY);
      pageEndY = pageEndY === null ? segment.endY : Math.max(pageEndY, segment.endY);
    });
    if (pageStartY !== null && pageEndY !== null && pageEndY - pageStartY >= pageHeight) break;
  }
  const cardMetrics = readCardMetrics(root, new Set(segments.flatMap((segment) => segment.selectedTargetKeys ?? [])));
  const page = buildReaderPages(segments, pageHeight, chapterIndex, cardMetrics, cardColumnCapacity)[0];
  return page ?? null;
}

interface TextLineFragment {
  startOffset: number;
  endOffset: number;
  top: number;
  bottom: number;
}

interface TextLineBand {
  startOffset: number;
  endOffset: number;
  top: number;
  bottom: number;
}

const TEXT_NODE_TYPE = 3;
const LINE_OVERLAP_EPSILON = 0.5;
const PAGE_EDGE_EPSILON = 1.25;
const MAX_STABILITY_MEASUREMENTS = 8;
const NEIGHBOR_PAGE_COUNT = 3;
const MEASUREMENT_PAGE_RADIUS = NEIGHBOR_PAGE_COUNT + 1;

interface VerticalMeasurementRange {
  top: number;
  bottom: number;
}

interface MeasuredPageWindow {
  pages: ReaderPaginationPage[];
  hasPreviousPages: boolean;
  hasNextPages: boolean;
}

function readerPaginationMeasurementError(message: string): Error {
  const error = new Error(message);
  error.name = 'ReaderPaginationMeasurementError';
  return error;
}

function rectBounds(element: Element, rootTop: number, presentationOffset: number): { top: number; bottom: number } {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top - rootTop - presentationOffset - PAGE_EDGE_EPSILON,
    bottom: rect.bottom - rootTop - presentationOffset + PAGE_EDGE_EPSILON,
  };
}

function collectRangeFragments(
  node: Text,
  localStart: number,
  localEnd: number,
  baseOffset: number,
  rootTop: number,
  presentationOffset: number,
  output: TextLineFragment[],
  verticalRange: VerticalMeasurementRange | null,
): void {
  if (localStart >= localEnd) return;
  const range = node.ownerDocument.createRange();
  range.setStart(node, localStart);
  range.setEnd(node, localEnd);
  if (verticalRange) {
    const bounds = range.getBoundingClientRect();
    const top = bounds.top - rootTop - presentationOffset;
    const bottom = bounds.bottom - rootTop - presentationOffset;
    if (bottom < verticalRange.top || top > verticalRange.bottom) return;
  }
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.height > 0);
  if (rects.length === 0) return;
  if (rects.length === 1 || localEnd - localStart === 1) {
    rects.forEach((rect) => {
      const top = rect.top - rootTop - presentationOffset;
      const bottom = rect.bottom - rootTop - presentationOffset;
      if (verticalRange && (bottom < verticalRange.top || top > verticalRange.bottom)) return;
      output.push({
        startOffset: baseOffset + localStart,
        endOffset: baseOffset + localEnd,
        top,
        bottom,
      });
    });
    return;
  }

  const middle = localStart + Math.floor((localEnd - localStart) / 2);
  collectRangeFragments(node, localStart, middle, baseOffset, rootTop, presentationOffset, output, verticalRange);
  collectRangeFragments(node, middle, localEnd, baseOffset, rootTop, presentationOffset, output, verticalRange);
}

function textOffsetBeforeElement(textElement: HTMLElement, element: HTMLElement): number {
  const range = textElement.ownerDocument.createRange();
  range.selectNodeContents(textElement);
  range.setEndBefore(element);
  return range.toString().length;
}

function textLineFragments(
  textElement: HTMLElement,
  rootTop: number,
  presentationOffset: number,
  verticalRange: VerticalMeasurementRange | null,
): TextLineFragment[] {
  const fragments: TextLineFragment[] = [];
  const walker = textElement.ownerDocument.createTreeWalker(textElement, NodeFilter.SHOW_TEXT);
  let canonicalOffset = 0;
  let currentNode = walker.nextNode();
  while (currentNode) {
    if (currentNode.nodeType === TEXT_NODE_TYPE) {
      const textNode = currentNode as Text;
      collectRangeFragments(
        textNode,
        0,
        textNode.data.length,
        canonicalOffset,
        rootTop,
        presentationOffset,
        fragments,
        verticalRange,
      );
      canonicalOffset += textNode.data.length;
    }
    currentNode = walker.nextNode();
  }

  if (canonicalOffset !== textElement.textContent?.length) {
    throw readerPaginationMeasurementError(
      `Rendered paragraph text offsets are inconsistent: renderedLength=${textElement.textContent?.length ?? 0}, measuredLength=${canonicalOffset}`,
    );
  }

  Array.from(textElement.querySelectorAll('img')).forEach((image) => {
    const rect = image.getBoundingClientRect();
    const bounds = {
      top: rect.top - rootTop - presentationOffset,
      bottom: rect.bottom - rootTop - presentationOffset,
    };
    if (bounds.bottom <= bounds.top) return;
    if (verticalRange && (bounds.bottom < verticalRange.top || bounds.top > verticalRange.bottom)) return;
    const offset = textOffsetBeforeElement(textElement, image);
    fragments.push({ startOffset: offset, endOffset: offset, ...bounds });
  });

  return fragments;
}

function includeSelectedWordBounds(
  segments: readonly ReaderPaginationSegment[],
  textElement: HTMLElement,
  rootTop: number,
  presentationOffset: number,
  verticalRange: VerticalMeasurementRange | null,
): ReaderPaginationSegment[] {
  const expandedSegments = segments.map((segment) => ({ ...segment }));
  Array.from(textElement.querySelectorAll<HTMLElement>('.unknown-word')).forEach((word) => {
    const bounds = rectBounds(word, rootTop, presentationOffset);
    if (bounds.bottom <= bounds.top) return;
    if (verticalRange && (bounds.bottom < verticalRange.top || bounds.top > verticalRange.bottom)) return;
    const startOffset = textOffsetBeforeElement(textElement, word);
    const endOffset = startOffset + (word.textContent?.length ?? 0);
    const matchingLines = expandedSegments.filter((segment) =>
      segment.endOffset > startOffset && segment.startOffset < endOffset);
    const firstLine = matchingLines[0];
    const lastLine = matchingLines[matchingLines.length - 1];
    if (!firstLine || !lastLine) {
      if (verticalRange) return;
      throw readerPaginationMeasurementError(
        `Selected word has no measured text line: startOffset=${startOffset}, endOffset=${endOffset}`,
      );
    }
    firstLine.startY = Math.min(firstLine.startY, bounds.top);
    lastLine.endY = Math.max(lastLine.endY, bounds.bottom);
  });
  return expandedSegments;
}

function textBoundsAtOffset(textElement: HTMLElement, textOffset: number): DOMRect | null {
  const walker = textElement.ownerDocument.createTreeWalker(textElement, NodeFilter.SHOW_TEXT);
  let canonicalOffset = 0;
  let lastText: Text | null = null;
  let currentNode = walker.nextNode();
  while (currentNode) {
    const textNode = currentNode as Text;
    const nextOffset = canonicalOffset + textNode.data.length;
    if (textOffset < nextOffset) {
      const localOffset = Math.max(0, textOffset - canonicalOffset);
      const range = textElement.ownerDocument.createRange();
      range.setStart(textNode, localOffset);
      range.setEnd(textNode, Math.min(textNode.data.length, localOffset + 1));
      const bounds = range.getBoundingClientRect();
      return bounds.height > 0 ? bounds : null;
    }
    canonicalOffset = nextOffset;
    lastText = textNode;
    currentNode = walker.nextNode();
  }
  if (textOffset === canonicalOffset && lastText && lastText.data.length > 0) {
    const range = textElement.ownerDocument.createRange();
    range.setStart(lastText, lastText.data.length - 1);
    range.setEnd(lastText, lastText.data.length);
    const bounds = range.getBoundingClientRect();
    return bounds.height > 0 ? bounds : null;
  }
  return null;
}

function mergeTextLineFragments(
  fragments: readonly TextLineFragment[],
  blockIndex: number,
): ReaderPaginationSegment[] {
  const orderedFragments = [...fragments].sort((left, right) =>
    left.top - right.top || left.bottom - right.bottom || left.startOffset - right.startOffset);
  const bands: TextLineBand[] = [];
  orderedFragments.forEach((fragment) => {
    const currentBand = bands[bands.length - 1];
    const overlapsLine = currentBand !== undefined
      && fragment.top <= currentBand.bottom + LINE_OVERLAP_EPSILON
      && fragment.bottom >= currentBand.top - LINE_OVERLAP_EPSILON;
    if (overlapsLine && currentBand) {
      currentBand.startOffset = Math.min(currentBand.startOffset, fragment.startOffset);
      currentBand.endOffset = Math.max(currentBand.endOffset, fragment.endOffset);
      currentBand.top = Math.min(currentBand.top, fragment.top);
      currentBand.bottom = Math.max(currentBand.bottom, fragment.bottom);
      return;
    }
    bands.push({
      startOffset: fragment.startOffset,
      endOffset: fragment.endOffset,
      top: fragment.top,
      bottom: fragment.bottom,
    });
  });

  return bands.map((band) => ({
    startY: band.top - PAGE_EDGE_EPSILON,
    endY: band.bottom + PAGE_EDGE_EPSILON,
    blockIndex,
    startOffset: band.startOffset,
    endOffset: band.endOffset,
    kind: 'text-line',
  }));
}

function selectedTargetsForLine(
  textElement: HTMLElement,
  segment: ReaderPaginationSegment,
  rootTop: number,
  presentationOffset: number,
): string[] {
  const lineTop = segment.startY + PAGE_EDGE_EPSILON;
  const lineBottom = segment.endY - PAGE_EDGE_EPSILON;
  return Array.from(textElement.querySelectorAll<HTMLElement>('[data-reader-selected-target]'))
    .filter((element) => Array.from(element.getClientRects()).some((rect) =>
      rect.bottom - presentationOffset > rootTop + lineTop
      && rect.top - presentationOffset < rootTop + lineBottom))
    .map((element) => element.dataset.readerSelectedTarget)
    .filter((targetKey): targetKey is string => targetKey !== undefined);
}

function atomicSegment(
  bounds: { top: number; bottom: number },
  blockIndex: number,
  textOffset: number,
): ReaderPaginationSegment {
  return {
    startY: bounds.top,
    endY: bounds.bottom,
    blockIndex,
    startOffset: textOffset,
    endOffset: textOffset,
    kind: 'atomic',
  };
}

function measuredBlockSegments(
  blockElement: HTMLElement,
  rootTop: number,
  blockIndex: number,
  verticalRange: VerticalMeasurementRange | null,
): ReaderPaginationSegment[] {
  const presentationOffset = Number(blockElement.dataset.readerPaginationOffset ?? '0');
  if (!Number.isFinite(presentationOffset)) {
    throw readerPaginationMeasurementError(
      `Rendered reader block has an invalid pagination offset: blockIndex=${blockIndex}, value=${blockElement.dataset.readerPaginationOffset ?? ''}`,
    );
  }
  const blockRect = blockElement.getBoundingClientRect();
  const sourceBlockBounds = {
    blockTopY: blockRect.top - rootTop - presentationOffset,
    blockBottomY: blockRect.bottom - rootTop - presentationOffset,
  };
  const blockBounds = rectBounds(blockElement, rootTop, presentationOffset);
  const textElement = blockElement.querySelector<HTMLElement>('[data-reader-text-block], .reader-text');
  if (!textElement) {
    if (verticalRange && (blockBounds.bottom < verticalRange.top || blockBounds.top > verticalRange.bottom)) return [];
    return [{ ...atomicSegment(blockBounds, blockIndex, 0), ...sourceBlockBounds }];
  }

  const textSegments = includeSelectedWordBounds(
    mergeTextLineFragments(textLineFragments(textElement, rootTop, presentationOffset, verticalRange), blockIndex),
    textElement,
    rootTop,
    presentationOffset,
    verticalRange,
  );
  if (textSegments.length === 0) {
    if (verticalRange && (blockBounds.bottom < verticalRange.top || blockBounds.top > verticalRange.bottom)) return [];
    return [{ ...atomicSegment(blockBounds, blockIndex, 0), ...sourceBlockBounds }];
  }
  return textSegments.map((segment) => ({
    ...segment,
    selectedTargetKeys: selectedTargetsForLine(textElement, segment, rootTop, presentationOffset),
    ...sourceBlockBounds,
  }));
}

function readRenderedSegmentsAroundAnchor(
  root: HTMLElement,
  pageHeight: number,
  anchorPage: ReaderPaginationPage,
): { segments: ReaderPaginationSegment[]; range: VerticalMeasurementRange } {
  const rootTop = root.getBoundingClientRect().top;
  const markedBlocks = Array.from(root.querySelectorAll<HTMLElement>('[data-reader-block-index]'));
  if (markedBlocks.length === 0) {
    throw readerPaginationMeasurementError('No rendered reader blocks have data-reader-block-index markers.');
  }

  const range = {
    top: anchorPage.startY - MEASUREMENT_PAGE_RADIUS * pageHeight,
    bottom: anchorPage.endY + MEASUREMENT_PAGE_RADIUS * pageHeight,
  };
  const segments: ReaderPaginationSegment[] = [];
  const anchorBlockPosition = markedBlocks.findIndex((element) =>
    Number(element.dataset.readerBlockIndex) === anchorPage.startLocation.blockIndex);
  if (anchorBlockPosition < 0) {
    throw readerPaginationMeasurementError(
      `Measured reader window has no anchor block: blockIndex=${anchorPage.startLocation.blockIndex}`,
    );
  }
  let firstBlockPosition = anchorBlockPosition;
  while (firstBlockPosition > 0) {
    const previousBlock = markedBlocks[firstBlockPosition - 1];
    if (!previousBlock) break;
    const previousOffset = Number(previousBlock.dataset.readerPaginationOffset ?? '0');
    const previousBounds = rectBounds(previousBlock, rootTop, previousOffset);
    if (previousBounds.bottom < range.top) break;
    firstBlockPosition -= 1;
  }

  const seenIndexes = new Set<number>();
  for (let elementIndex = firstBlockPosition; elementIndex < markedBlocks.length; elementIndex += 1) {
    const blockElement = markedBlocks[elementIndex];
    if (!blockElement) continue;
    const blockIndex = Number(blockElement.dataset.readerBlockIndex);
    if (!Number.isInteger(blockIndex) || blockIndex < 0) {
      throw readerPaginationMeasurementError(
        `Rendered reader block has an invalid data-reader-block-index: value=${blockElement.dataset.readerBlockIndex ?? ''}`,
      );
    }
    if (seenIndexes.has(blockIndex)) {
      throw readerPaginationMeasurementError(`Rendered reader block index is duplicated: blockIndex=${blockIndex}`);
    }
    seenIndexes.add(blockIndex);
    const blockBounds = rectBounds(blockElement, rootTop, Number(blockElement.dataset.readerPaginationOffset ?? '0'));
    if (blockBounds.top > range.bottom) break;
    if (blockBounds.bottom < range.top) continue;
    segments.push(...measuredBlockSegments(blockElement, rootTop, blockIndex, range));
  }
  const firstBlockElement = markedBlocks[0];
  if (!firstBlockElement) throw readerPaginationMeasurementError('Rendered reader has no first block.');
  const firstBlockIndex = Number(firstBlockElement.dataset.readerBlockIndex);
  if (firstBlockPosition === 0) {
    const firstBlockBounds = rectBounds(
      firstBlockElement,
      rootTop,
      Number(firstBlockElement.dataset.readerPaginationOffset ?? '0'),
    );
    if (firstBlockBounds.top < range.top || firstBlockBounds.top > range.bottom) return { segments, range };
    segments.push(...leadingPreambleSegments(root, firstBlockElement, firstBlockIndex, rootTop)
      .filter((segment) => segment.endY >= range.top && segment.startY <= range.bottom));
  }
  return { segments, range };
}

function readingRowForRoot(root: HTMLElement): HTMLElement {
  return root.closest<HTMLElement>('[data-reader-pagination-host]')
    ?? root.closest<HTMLElement>('[data-testid="reading-row"]')
    ?? root;
}

function readCardMetrics(
  root: HTMLElement,
  selectedTargetKeys: ReadonlySet<string> | null,
): ReaderPaginationCardMetric[] {
  const readingRow = readingRowForRoot(root);
  return Array.from(readingRow.querySelectorAll<HTMLElement>('[data-reader-card-target]'))
    .flatMap((wrapper) => {
      const targetKey = wrapper.dataset.readerCardTarget;
      if (selectedTargetKeys && targetKey && !selectedTargetKeys.has(targetKey)) return [];
      const height = wrapper.getBoundingClientRect().height;
      if (!targetKey) {
        throw readerPaginationMeasurementError('Rendered reader card wrapper has no target key.');
      }
      if (!Number.isFinite(height) || height <= 0) return [];
      return [{ targetKey, height }];
    });
}

function cardColumnCapacityForRoot(root: HTMLElement): number {
  const readingRow = readingRowForRoot(root);
  const groupContentWidth = Math.max(1, readingRow.clientWidth - 8);
  return Math.max(1, Math.floor((groupContentWidth + 12) / (266 + 12)));
}

function leadingPreambleSegments(
  root: HTMLElement,
  firstBlockElement: HTMLElement,
  firstBlockIndex: number,
  rootTop: number,
): ReaderPaginationSegment[] {
  const ancestorPath: HTMLElement[] = [];
  let currentElement = firstBlockElement;
  while (currentElement.parentElement && currentElement.parentElement !== root) {
    ancestorPath.push(currentElement);
    currentElement = currentElement.parentElement;
  }
  ancestorPath.push(currentElement);

  const precedingElements = new Set<HTMLElement>();
  ancestorPath.forEach((element) => {
    let previousElement = element.previousElementSibling;
    while (previousElement) {
      if (previousElement instanceof HTMLElement) precedingElements.add(previousElement);
      previousElement = previousElement.previousElementSibling;
    }
  });
  const documentOrder = [...precedingElements].sort((left, right) => {
    const position = left.compareDocumentPosition(right);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  return documentOrder.map((element) => atomicSegment(rectBounds(element, rootTop, 0), firstBlockIndex, 0));
}

function segmentsSignature(
  segments: readonly ReaderPaginationSegment[],
  cardMetrics: readonly ReaderPaginationCardMetric[],
  cardColumnCapacity: number,
): string {
  return JSON.stringify([
    cardColumnCapacity,
    cardMetrics.map((metric) => [metric.targetKey, Math.round(metric.height * 100) / 100]),
    segments.map((segment) => [
    segment.blockIndex,
    segment.startOffset,
    segment.endOffset,
    Math.round(segment.startY * 100) / 100,
    Math.round(segment.endY * 100) / 100,
    Math.round((segment.blockTopY ?? 0) * 100) / 100,
    Math.round((segment.blockBottomY ?? 0) * 100) / 100,
    segment.kind,
    segment.selectedTargetKeys ?? [],
    ]),
  ]);
}

function waitForNextFrame(signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      signal.removeEventListener('abort', cancelFrame);
      resolve(true);
    });
    const cancelFrame = (): void => {
      window.cancelAnimationFrame(frame);
      resolve(false);
    };
    signal.addEventListener('abort', cancelFrame, { once: true });
  });
}

function compareReaderLocations(left: ReaderLocation, right: ReaderLocation): number {
  if (left.chapterIndex !== right.chapterIndex) return left.chapterIndex - right.chapterIndex;
  if (left.blockIndex !== right.blockIndex) return left.blockIndex - right.blockIndex;
  return left.textOffset - right.textOffset;
}

function equalReaderLocations(left: ReaderLocation, right: ReaderLocation): boolean {
  return compareReaderLocations(left, right) === 0;
}

function pageGeometrySignature(page: ReaderPaginationPage): string {
  return JSON.stringify([
    page.startLocation,
    page.endLocation,
    page.blockFragments,
    page.blockDisplayOffsets,
    page.cardGroups,
    page.cardTargetKeys,
    page.reservedCardHeight,
    page.presentationHeight,
  ]);
}

function hasContentBeforeLocation(root: HTMLElement, location: ReaderLocation): boolean {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-reader-block-index]')).some((element) => {
    const blockIndex = Number(element.dataset.readerBlockIndex);
    if (blockIndex < location.blockIndex) return true;
    if (blockIndex > location.blockIndex || location.textOffset === 0) return false;
    return true;
  });
}

function hasContentAfterLocation(root: HTMLElement, location: ReaderLocation): boolean {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-reader-block-index]')).some((element) => {
    const blockIndex = Number(element.dataset.readerBlockIndex);
    if (blockIndex > location.blockIndex) return true;
    if (blockIndex < location.blockIndex) return false;
    const textElement = element.querySelector<HTMLElement>('[data-reader-text-block], .reader-text');
    return (textElement?.textContent?.length ?? 0) > location.textOffset;
  });
}

/** Canonical offsets may meet across paragraph boundaries or intervening whitespace. */
function pageBoundariesTouch(root: HTMLElement, end: ReaderLocation, start: ReaderLocation): boolean {
  if (equalReaderLocations(end, start)) return true;
  if (end.chapterIndex !== start.chapterIndex || compareReaderLocations(end, start) > 0) return false;
  const block = root.querySelector<HTMLElement>(`[data-reader-block-index="${end.blockIndex}"]`);
  const text = block?.querySelector<HTMLElement>('[data-reader-text-block], .reader-text')?.textContent ?? '';
  if (end.blockIndex === start.blockIndex) {
    return text.slice(end.textOffset, start.textOffset).trim().length === 0;
  }
  return start.blockIndex === end.blockIndex + 1 && start.textOffset === 0 && end.textOffset === text.length;
}

function mergeMeasuredPages(
  root: HTMLElement,
  existingPages: readonly ReaderPaginationPage[],
  measuredPages: readonly ReaderPaginationPage[],
  anchor: ReaderLocation | null,
): ReaderPaginationPage[] {
  const mergedPages = [...existingPages].sort((left, right) =>
    compareReaderLocations(left.startLocation, right.startLocation));
  const orderedMeasuredPages = [...measuredPages].sort((left, right) =>
    compareReaderLocations(left.startLocation, right.startLocation));
  const existingAnchor = anchor ? mergedPages.find((page) => equalReaderLocations(page.startLocation, anchor)) : null;
  const measuredAnchor = anchor ? orderedMeasuredPages.find((page) => equalReaderLocations(page.startLocation, anchor)) : null;
  const knownGeometryChanged = existingAnchor && measuredAnchor
    ? pageGeometrySignature(existingAnchor) !== pageGeometrySignature(measuredAnchor)
    : true;
  if (existingAnchor && measuredAnchor && !knownGeometryChanged) {
    const firstExisting = mergedPages[0];
    const lastExisting = mergedPages[mergedPages.length - 1];
    const prefixEnd = orderedMeasuredPages.findIndex((page) => pageBoundariesTouch(root, page.endLocation, firstExisting.startLocation));
    const suffixStart = orderedMeasuredPages.findIndex((page) => pageBoundariesTouch(root, lastExisting.endLocation, page.startLocation));
    return [
      ...(prefixEnd >= 0 ? orderedMeasuredPages.slice(0, prefixEnd + 1) : []),
      ...mergedPages.map((page) => orderedMeasuredPages.find((measured) =>
        equalReaderLocations(page.startLocation, measured.startLocation)
        && equalReaderLocations(page.endLocation, measured.endLocation)) ?? page),
      ...(suffixStart >= 0 ? orderedMeasuredPages.slice(suffixStart) : []),
    ];
  }
  if (orderedMeasuredPages.length > 0 && mergedPages.length > 0) {
    const firstMeasuredPage = orderedMeasuredPages[0];
    const lastMeasuredPage = orderedMeasuredPages[orderedMeasuredPages.length - 1];
    if (!firstMeasuredPage || !lastMeasuredPage) return orderedMeasuredPages;
    let prefixBoundaryIndex = -1;
    mergedPages.forEach((page, index) => {
      if (pageBoundariesTouch(root, page.endLocation, firstMeasuredPage.startLocation)) prefixBoundaryIndex = index;
    });
    const suffixBoundaryIndex = mergedPages.findIndex((page) =>
      pageBoundariesTouch(root, lastMeasuredPage.endLocation, page.startLocation));
    const preservedPrefix = prefixBoundaryIndex >= 0 ? mergedPages.slice(0, prefixBoundaryIndex + 1) : [];
    const preservedSuffix = suffixBoundaryIndex >= 0 ? mergedPages.slice(suffixBoundaryIndex) : [];
    return [...preservedPrefix, ...orderedMeasuredPages, ...preservedSuffix];
  }

  return orderedMeasuredPages.length > 0 ? orderedMeasuredPages : mergedPages;
}

function readPageWindow(
  root: HTMLElement,
  pageHeight: number,
  chapterIndex: number,
  anchorPage: ReaderPaginationPage,
  cardColumnCapacity: number,
): MeasuredPageWindow {
  const { segments } = readRenderedSegmentsAroundAnchor(root, pageHeight, anchorPage);
  const orderedSegments = [...segments].sort((left, right) =>
    left.startY - right.startY
    || left.endY - right.endY
    || left.blockIndex - right.blockIndex
    || left.startOffset - right.startOffset);
  const anchorSegmentIndex = orderedSegments.findIndex((segment) =>
    segment.blockIndex === anchorPage.startLocation.blockIndex
    && segment.startOffset === anchorPage.startLocation.textOffset);
  if (anchorSegmentIndex < 0) {
    throw readerPaginationMeasurementError(
      `Measured reader window lost its anchor segment: blockIndex=${anchorPage.startLocation.blockIndex}, textOffset=${anchorPage.startLocation.textOffset}`,
    );
  }
  const cardTargetKeys = new Set(orderedSegments.flatMap((segment) => segment.selectedTargetKeys ?? []));
  const cardMetrics = readCardMetrics(root, cardTargetKeys);
  const previousPages = buildReaderPages(
    orderedSegments.slice(0, anchorSegmentIndex),
    pageHeight,
    chapterIndex,
    cardMetrics,
    cardColumnCapacity,
  );
  const nextSegmentIndex = orderedSegments.findIndex((segment) => compareReaderLocations({
    chapterIndex,
    blockIndex: segment.blockIndex,
    textOffset: segment.endOffset,
  }, anchorPage.endLocation) > 0);
  const anchoredPages = [anchorPage, ...buildReaderPages(
    nextSegmentIndex < 0 ? [] : orderedSegments.slice(nextSegmentIndex),
    pageHeight,
    chapterIndex,
    cardMetrics,
    cardColumnCapacity,
  )];
  const markedBlocks = Array.from(root.querySelectorAll<HTMLElement>('[data-reader-block-index]'));
  const firstSegment = orderedSegments[0];
  const lastSegment = orderedSegments[orderedSegments.length - 1];
  if (!firstSegment || !lastSegment) {
    throw readerPaginationMeasurementError('Measured reader window has no segments.');
  }
  const hasEarlierContent = hasContentBeforeLocation(root, {
    chapterIndex,
    blockIndex: firstSegment.blockIndex,
    textOffset: firstSegment.startOffset,
  });
  const hasLaterContent = hasContentAfterLocation(root, {
    chapterIndex,
    blockIndex: lastSegment.blockIndex,
    textOffset: lastSegment.endOffset,
  });
  const completePreviousPages = hasEarlierContent ? previousPages.slice(1) : previousPages;
  const nearestPreviousPages = completePreviousPages.slice(-NEIGHBOR_PAGE_COUNT);
  const nextPages = hasLaterContent && anchoredPages.length <= NEIGHBOR_PAGE_COUNT + 1
    ? anchoredPages.slice(0, -1)
    : anchoredPages;
  const nearestNextPages = nextPages.slice(0, NEIGHBOR_PAGE_COUNT + 1);
  return {
    pages: [...nearestPreviousPages, ...nearestNextPages],
    hasPreviousPages: hasEarlierContent,
    hasNextPages: hasLaterContent,
  };
}

async function measureStablePageWindow(
  root: HTMLElement,
  pageHeight: number,
  chapterIndex: number,
  anchor: ReaderLocation | null,
  endBoundary: ReaderLocation | null,
  signal: AbortSignal,
): Promise<MeasuredPageWindow | null> {
  let previousSignature: string | null = null;
  const cardColumnCapacity = cardColumnCapacityForRoot(root);
  for (let measurementIndex = 0; measurementIndex < MAX_STABILITY_MEASUREMENTS; measurementIndex += 1) {
    if (signal.aborted) return null;
    const anchorPage = readAnchorPage(root, pageHeight, chapterIndex, anchor, cardColumnCapacity, endBoundary);
    if (!anchorPage) return null;
    const { segments } = readRenderedSegmentsAroundAnchor(root, pageHeight, anchorPage);
    const cardTargetKeys = new Set(segments.flatMap((segment) => segment.selectedTargetKeys ?? []));
    const cardMetrics = readCardMetrics(root, cardTargetKeys);
    const firstSignature = JSON.stringify([
      segmentsSignature(segments, cardMetrics, cardColumnCapacity),
      pageGeometrySignature(anchorPage),
    ]);
    if (firstSignature === previousSignature) {
      return readPageWindow(root, pageHeight, chapterIndex, anchorPage, cardColumnCapacity);
    }
    previousSignature = firstSignature;
    if (!await waitForNextFrame(signal)) return null;
  }
  throw readerPaginationMeasurementError(
    `Reader layout kept changing during pagination measurement: measurements=${MAX_STABILITY_MEASUREMENTS}`,
  );
}

function layoutSignature(
  layoutKey: string,
  chapterIndex: number,
  pageHeight: number,
  pages: readonly ReaderPaginationPage[],
  hasPreviousPages: boolean,
  hasNextPages: boolean,
): string {
  const input = JSON.stringify([
    layoutKey,
    chapterIndex,
    Math.round(pageHeight * 100) / 100,
    hasPreviousPages,
    hasNextPages,
    pages.map((page) => [
      Math.round(page.startY * 100) / 100,
      Math.round(page.endY * 100) / 100,
      page.startLocation.blockIndex,
      page.startLocation.textOffset,
      page.endLocation.blockIndex,
      page.endLocation.textOffset,
      page.issues,
      page.cardTargetKeys,
      Math.round(page.reservedCardHeight * 100) / 100,
      page.cardGroups,
      page.blockDisplayOffsets,
      page.blockFragments,
      Math.round(page.textClipHeight * 100) / 100,
      Math.round(page.presentationHeight * 100) / 100,
    ]),
  ]);
  let firstHash = 0x811c9dc5;
  let secondHash = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    firstHash = Math.imul(firstHash ^ codePoint, 0x01000193);
    secondHash = Math.imul(secondHash ^ codePoint, 0x5bd1e995);
  }
  return `${(firstHash >>> 0).toString(16).padStart(8, '0')}${(secondHash >>> 0).toString(16).padStart(8, '0')}`;
}

function layoutEdgeFlags(
  root: HTMLElement,
  pages: readonly ReaderPaginationPage[],
): { hasPreviousPages: boolean; hasNextPages: boolean } {
  const firstPage = pages[0];
  const lastPage = pages[pages.length - 1];
  if (!firstPage || !lastPage) return { hasPreviousPages: false, hasNextPages: false };
  return {
    hasPreviousPages: hasContentBeforeLocation(root, firstPage.startLocation),
    hasNextPages: hasContentAfterLocation(root, lastPage.endLocation),
  };
}

function geometryElements(node: Node): Element[] {
  if (!(node instanceof Element)) return [];
  const selector = '[data-reader-block-index], [data-reader-card-target], [data-definition-card="true"], img';
  return [
    ...(node.matches(selector) ? [node] : []),
    ...Array.from(node.querySelectorAll(selector)),
  ];
}

function isIdenticalStyleTextReplacement(record: MutationRecord): boolean {
  if (record.type !== 'childList' || !(record.target instanceof HTMLStyleElement)) return false;
  const addedNodes = Array.from(record.addedNodes);
  const removedNodes = Array.from(record.removedNodes);
  return addedNodes.length > 0
    && addedNodes.length === removedNodes.length
    && addedNodes.every((node, index) => node.nodeType === Node.TEXT_NODE
      && removedNodes[index]?.nodeType === Node.TEXT_NODE
      && node.textContent === removedNodes[index]?.textContent);
}

/** Keep compatible pages available and remeasure them as rendered chapter geometry changes. */
export function useReaderPagination({
  rootRef,
  initialLayout,
  enabled,
  settled,
  getMeasurementKey,
  layoutKey,
  chapterIndex,
  pageHeight,
  anchor,
}: UseReaderPaginationOptions): UseReaderPaginationResult {
  const [layout, setLayout] = useState<ReaderPaginationLayout | null>(null);
  const [measurementError, setMeasurementError] = useState<ReaderPaginationErrorState | null>(null);
  const [settledMeasurementRevision, setSettledMeasurementRevision] = useState(0);
  const [measuredMeasurementKey, setMeasuredMeasurementKey] = useState<string | null>(null);
  const settledRef = useRef(settled);
  const measurementKeyRef = useRef(getMeasurementKey);
  const layoutRef = useRef<ReaderPaginationLayout | null>(null);
  const scheduleMeasurementRef = useRef<() => void>(() => {});
  const boundaryRequestRef = useRef<BoundaryPageRequest | null>(null);
  const requestBoundaryPage = useCallback((direction: 'previous' | 'next'): void => {
    const currentLayout = layoutRef.current;
    if (!currentLayout || currentLayout.pages.length === 0) return;
    const hasMorePages = direction === 'previous'
      ? currentLayout.hasPreviousPages
      : currentLayout.hasNextPages;
    if (!hasMorePages) return;
    const edgePage = direction === 'previous'
      ? currentLayout.pages[0]
      : currentLayout.pages[currentLayout.pages.length - 1];
    if (!edgePage) return;
    boundaryRequestRef.current = { direction, anchor: edgePage.startLocation };
    scheduleMeasurementRef.current();
  }, []);
  const compatibleInitialLayout = initialLayout?.layoutKey === layoutKey
    && initialLayout.chapterIndex === chapterIndex
    && initialLayout.pageHeight === pageHeight
    ? initialLayout
    : null;
  const internalLayoutIsCompatible = layout?.layoutKey === layoutKey
    && layout.chapterIndex === chapterIndex
    && layout.pageHeight === pageHeight;
  if (compatibleInitialLayout && !internalLayoutIsCompatible
    && (layoutRef.current?.layoutKey !== layoutKey
      || layoutRef.current?.chapterIndex !== chapterIndex
      || layoutRef.current?.pageHeight !== pageHeight)) {
    layoutRef.current = compatibleInitialLayout;
  }
  const currentMeasurementKey = getMeasurementKey(layoutRef.current);

  useLayoutEffect(() => {
    if (!enabled || !compatibleInitialLayout || internalLayoutIsCompatible) return;
    layoutRef.current = compatibleInitialLayout;
    setLayout((previous) => previous?.layoutKey === compatibleInitialLayout.layoutKey
      && previous.chapterIndex === compatibleInitialLayout.chapterIndex
      && previous.pageHeight === compatibleInitialLayout.pageHeight
      && previous.signature === compatibleInitialLayout.signature
      ? previous
      : compatibleInitialLayout);
  }, [compatibleInitialLayout, enabled, internalLayoutIsCompatible]);

  useLayoutEffect(() => {
    settledRef.current = settled;
    if (settled) scheduleMeasurementRef.current();
  }, [settled]);

  useLayoutEffect(() => {
    measurementKeyRef.current = getMeasurementKey;
    if (currentMeasurementKey !== null && measuredMeasurementKey !== currentMeasurementKey) {
      scheduleMeasurementRef.current();
    }
  }, [getMeasurementKey, currentMeasurementKey, measuredMeasurementKey]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) {
      scheduleMeasurementRef.current = () => {};
      boundaryRequestRef.current = null;
      layoutRef.current = null;
      setLayout(null);
      setMeasurementError(null);
      return;
    }
    if (!Number.isFinite(pageHeight) || pageHeight <= 0) {
      setMeasurementError({
        layoutKey,
        error: new RangeError(`Reader pagination page height must be positive: pageHeight=${pageHeight}`),
      });
      return;
    }

    const controller = new AbortController();
    let active = true;
    let runPending = false;
    let running = false;
    let measurementFailed = false;
    let scheduledFrame = 0;

    const scheduleMeasurement = (): void => {
      if (!active || controller.signal.aborted) return;
      if (running) {
        runPending = true;
        return;
      }
      if (scheduledFrame !== 0) return;
      measurementFailed = false;
      scheduledFrame = window.requestAnimationFrame(() => {
        scheduledFrame = 0;
        void runMeasurement();
      });
    };

    const runMeasurement = async (): Promise<void> => {
      if (!active || running) return;
      running = true;
      runPending = false;
      const measurementStartedSettled = settledRef.current;
      let measurementStartedKey: string | null = null;
      try {
        measurementStartedKey = measurementKeyRef.current(layoutRef.current);
        const currentLayout = layoutRef.current;
        const targetAnchor = boundaryRequestRef.current?.anchor ?? anchor;
        const endBoundary = currentLayout?.layoutKey === layoutKey
          ? currentLayout.pages.find((page) => targetAnchor
            && equalReaderLocations(page.startLocation, targetAnchor))?.endLocation ?? null
          : null;
        const anchorPage = readAnchorPage(
          root,
          pageHeight,
          chapterIndex,
          targetAnchor,
          cardColumnCapacityForRoot(root),
          endBoundary,
        );
        if (active && anchorPage) {
          const retainedPages = currentLayout?.layoutKey === layoutKey
            && currentLayout.chapterIndex === chapterIndex
            && currentLayout.pageHeight === pageHeight
            ? currentLayout.pages
            : [];
          const knownAnchorPage = retainedPages.find((page) =>
            equalReaderLocations(page.startLocation, anchorPage.startLocation));
          const stagedPages = knownAnchorPage ? [...retainedPages] : [anchorPage];
          const stageFlags = layoutEdgeFlags(root, stagedPages);
          const anchorLayout: ReaderPaginationLayout = {
            chapterIndex,
            layoutKey,
            signature: layoutSignature(layoutKey, chapterIndex, pageHeight, stagedPages,
              stageFlags.hasPreviousPages, stageFlags.hasNextPages),
            pageHeight,
            pages: stagedPages,
            ...stageFlags,
          };
          if (layoutRef.current?.signature !== anchorLayout.signature) {
            layoutRef.current = anchorLayout;
            setLayout(anchorLayout);
          }
          const anchorMeasurementKey = measurementKeyRef.current(anchorLayout);
          if (anchorMeasurementKey !== null && (!knownAnchorPage
            || pageGeometrySignature(knownAnchorPage) === pageGeometrySignature(anchorPage))) {
            setMeasuredMeasurementKey(anchorMeasurementKey);
          }
          if (!await waitForNextFrame(controller.signal)
            || !await waitForNextFrame(controller.signal)) return;
        }

        const measuredWindow = await measureStablePageWindow(
          root,
          pageHeight,
          chapterIndex,
          targetAnchor,
          endBoundary,
          controller.signal,
        );
        if (active && measuredWindow) {
          const previousLayout = layoutRef.current;
          const retainedPages = previousLayout?.layoutKey === layoutKey
            && previousLayout.chapterIndex === chapterIndex
            && previousLayout.pageHeight === pageHeight
            ? previousLayout.pages
            : [];
          const pages = mergeMeasuredPages(root, retainedPages, measuredWindow.pages, targetAnchor);
          const edgeFlags = layoutEdgeFlags(root, pages);
          const nextLayout: ReaderPaginationLayout = {
            chapterIndex,
            layoutKey,
            signature: layoutSignature(layoutKey, chapterIndex, pageHeight, pages,
              edgeFlags.hasPreviousPages, edgeFlags.hasNextPages),
            pageHeight,
            pages,
            ...edgeFlags,
          };
          if (layoutRef.current?.signature !== nextLayout.signature) {
            layoutRef.current = nextLayout;
            setLayout(nextLayout);
          }
          const boundaryRequest = boundaryRequestRef.current;
          if (boundaryRequest) {
            const previousEdge = boundaryRequest.direction === 'previous'
              ? retainedPages[0]?.startLocation
              : retainedPages[retainedPages.length - 1]?.startLocation;
            const nextEdge = boundaryRequest.direction === 'previous'
              ? pages[0]?.startLocation
              : pages[pages.length - 1]?.startLocation;
            const expanded = previousEdge !== undefined && nextEdge !== undefined
              && (boundaryRequest.direction === 'previous'
                ? compareReaderLocations(nextEdge, previousEdge) < 0
                : compareReaderLocations(nextEdge, previousEdge) > 0);
            const morePagesRemain = boundaryRequest.direction === 'previous'
              ? edgeFlags.hasPreviousPages
              : edgeFlags.hasNextPages;
            if (expanded || !morePagesRemain) boundaryRequestRef.current = null;
          }
          if (measurementStartedSettled && settledRef.current && !runPending) {
            setSettledMeasurementRevision((revision) => revision + 1);
          }
          const measurementCompletedKey = measurementKeyRef.current(nextLayout);
          if (measurementStartedKey !== null
            && measurementCompletedKey === measurementStartedKey
            && !runPending) {
            setMeasuredMeasurementKey(measurementCompletedKey);
          }
          setMeasurementError(null);
        }
      } catch (failure) {
        if (active && !controller.signal.aborted) {
          measurementFailed = true;
          const error = failure instanceof Error
            ? failure
            : readerPaginationMeasurementError(`Reader pagination failed: ${String(failure)}`);
          setMeasurementError({ layoutKey, error });
        }
      } finally {
        running = false;
        if (active && runPending && !measurementFailed && !controller.signal.aborted) {
          runPending = false;
          scheduleMeasurement();
        } else if (active
          && !measurementFailed
          && measurementStartedKey !== measurementKeyRef.current(layoutRef.current)) {
          scheduleMeasurement();
        }
      }
    };

    const measurementHost = readingRowForRoot(root);
    const resizeObserver = new ResizeObserver(scheduleMeasurement);
    const observedElements = new Set<Element>();
    const observeGeometry = (element: Element): void => {
      if (observedElements.has(element)) return;
      observedElements.add(element);
      resizeObserver.observe(element);
    };
    const observeTree = (node: Node): void => {
      geometryElements(node).forEach(observeGeometry);
    };
    const unobserveTree = (node: Node): void => {
      geometryElements(node).forEach((element) => {
        if (observedElements.delete(element)) resizeObserver.unobserve(element);
      });
    };
    observeGeometry(root);
    measurementHost.querySelectorAll('[data-reader-block-index], [data-reader-card-target], [data-definition-card="true"], img')
      .forEach(observeGeometry);
    const mutationObserver = new MutationObserver((records) => {
      let geometryChanged = false;
      records.forEach((record) => {
        if (record.type === 'childList') {
          if (isIdenticalStyleTextReplacement(record)) return;
          geometryChanged = true;
          record.addedNodes.forEach(observeTree);
          record.removedNodes.forEach(unobserveTree);
        } else if (record.type === 'characterData') {
          geometryChanged = true;
        } else if (record.type === 'attributes') {
          geometryChanged = true;
        }
      });
      if (geometryChanged) scheduleMeasurement();
    });
    mutationObserver.observe(measurementHost, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'data-reader-selected-target',
        'data-definition-count',
        'data-definition-height-limited',
      ],
    });
    scheduleMeasurementRef.current = scheduleMeasurement;
    document.fonts.addEventListener('loadingdone', scheduleMeasurement);
    window.addEventListener('resize', scheduleMeasurement);
    if (settledRef.current) scheduleMeasurement();

    return () => {
      active = false;
      controller.abort();
      scheduleMeasurementRef.current = () => {};
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      document.fonts.removeEventListener('loadingdone', scheduleMeasurement);
      window.removeEventListener('resize', scheduleMeasurement);
      if (scheduledFrame !== 0) window.cancelAnimationFrame(scheduledFrame);
    };
  }, [rootRef, enabled, layoutKey, chapterIndex, pageHeight, anchor]);

  const error = measurementError?.layoutKey === layoutKey ? measurementError.error : null;
  const renderedLayout = internalLayoutIsCompatible ? layout : compatibleInitialLayout ?? layout;
  const renderedMeasurementKey = compatibleInitialLayout && !internalLayoutIsCompatible
    ? getMeasurementKey(compatibleInitialLayout) ?? measuredMeasurementKey
    : measuredMeasurementKey;
  const isReady = enabled && error === null
    && renderedLayout?.layoutKey === layoutKey
    && renderedLayout.chapterIndex === chapterIndex
    && renderedLayout.pageHeight === pageHeight;

  return {
    layout: renderedLayout,
    isReady,
    error,
    settledMeasurementRevision,
    measuredMeasurementKey: renderedMeasurementKey,
    requestBoundaryPage,
  };
}
