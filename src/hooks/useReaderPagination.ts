import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  buildReaderPages,
  type ReaderPaginationLayout,
  type ReaderPaginationPage,
  type ReaderPaginationSegment,
} from '@/core/reader-pagination';
import type { ReaderLocation } from '@/core/types';

interface UseReaderPaginationOptions {
  rootRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  settled: boolean;
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
}

function readAnchorPage(
  root: HTMLElement,
  pageHeight: number,
  chapterIndex: number,
  anchor: ReaderLocation | null,
): ReaderPaginationPage | null {
  const markedBlocks = Array.from(root.querySelectorAll<HTMLElement>('[data-reader-block-index]'));
  const targetBlock = anchor
    ? markedBlocks.find((element) => Number(element.dataset.readerBlockIndex) === anchor.blockIndex)
    : markedBlocks[0];
  if (!targetBlock) return null;

  const blockIndex = Number(targetBlock.dataset.readerBlockIndex);
  const rootTop = root.getBoundingClientRect().top;
  const targetBlockIndex = markedBlocks.indexOf(targetBlock);
  const segments: ReaderPaginationSegment[] = [];
  let firstSegmentIndex = 0;
  let pageStartY: number | null = null;
  let pageEndY: number | null = null;
  for (const [elementIndex, element] of markedBlocks.entries()) {
    if (elementIndex < targetBlockIndex) continue;
    const currentBlockIndex = Number(element.dataset.readerBlockIndex);
    const blockSegments = measuredBlockSegments(element, rootTop, currentBlockIndex);
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
    segments.push(...remainingSegments);
    remainingSegments.forEach((segment) => {
      pageStartY = pageStartY === null ? segment.startY : Math.min(pageStartY, segment.startY);
      pageEndY = pageEndY === null ? segment.endY : Math.max(pageEndY, segment.endY);
    });
    if (pageStartY !== null && pageEndY !== null && pageEndY - pageStartY >= pageHeight) break;
  }
  const page = buildReaderPages(segments, pageHeight, chapterIndex)[0];
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

interface CardRowBand {
  top: number;
  bottom: number;
}

const TEXT_NODE_TYPE = 3;
const LINE_OVERLAP_EPSILON = 0.5;
const PAGE_EDGE_EPSILON = 1.25;
const MAX_STABILITY_MEASUREMENTS = 8;

function readerPaginationMeasurementError(message: string): Error {
  const error = new Error(message);
  error.name = 'ReaderPaginationMeasurementError';
  return error;
}

function rectBounds(element: Element, rootTop: number): { top: number; bottom: number } {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top - rootTop - PAGE_EDGE_EPSILON,
    bottom: rect.bottom - rootTop + PAGE_EDGE_EPSILON,
  };
}

function collectRangeFragments(
  node: Text,
  localStart: number,
  localEnd: number,
  baseOffset: number,
  rootTop: number,
  output: TextLineFragment[],
): void {
  if (localStart >= localEnd) return;
  const range = node.ownerDocument.createRange();
  range.setStart(node, localStart);
  range.setEnd(node, localEnd);
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.height > 0);
  if (rects.length === 0) return;
  if (rects.length === 1 || localEnd - localStart === 1) {
    rects.forEach((rect) => output.push({
      startOffset: baseOffset + localStart,
      endOffset: baseOffset + localEnd,
      top: rect.top - rootTop - PAGE_EDGE_EPSILON,
      bottom: rect.bottom - rootTop + PAGE_EDGE_EPSILON,
    }));
    return;
  }

  const middle = localStart + Math.floor((localEnd - localStart) / 2);
  collectRangeFragments(node, localStart, middle, baseOffset, rootTop, output);
  collectRangeFragments(node, middle, localEnd, baseOffset, rootTop, output);
}

function inlineImageOffset(textElement: HTMLElement, image: HTMLImageElement): number {
  const range = textElement.ownerDocument.createRange();
  range.selectNodeContents(textElement);
  range.setEndBefore(image);
  return range.toString().length;
}

function textLineFragments(textElement: HTMLElement, rootTop: number): TextLineFragment[] {
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
        fragments,
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
    const bounds = rectBounds(image, rootTop);
    if (bounds.bottom <= bounds.top) return;
    const offset = inlineImageOffset(textElement, image);
    fragments.push({ startOffset: offset, endOffset: offset, ...bounds });
  });

  return fragments;
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
    startY: band.top,
    endY: band.bottom,
    blockIndex,
    startOffset: band.startOffset,
    endOffset: band.endOffset,
    kind: 'text-line',
  }));
}

function mergeCardRows(cards: readonly HTMLElement[], rootTop: number): CardRowBand[] {
  const orderedCards = cards.map((card) => rectBounds(card, rootTop))
    .filter((bounds) => bounds.bottom > bounds.top)
    .sort((left, right) => left.top - right.top || left.bottom - right.bottom);
  const rows: CardRowBand[] = [];
  orderedCards.forEach((cardBounds) => {
    const currentRow = rows[rows.length - 1];
    const sameVisualRow = currentRow !== undefined
      && cardBounds.top <= currentRow.bottom + LINE_OVERLAP_EPSILON
      && cardBounds.bottom >= currentRow.top - LINE_OVERLAP_EPSILON;
    if (sameVisualRow && currentRow) {
      currentRow.top = Math.min(currentRow.top, cardBounds.top);
      currentRow.bottom = Math.max(currentRow.bottom, cardBounds.bottom);
      return;
    }
    rows.push({ top: cardBounds.top, bottom: cardBounds.bottom });
  });
  return rows;
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
): ReaderPaginationSegment[] {
  const textElement = blockElement.querySelector<HTMLElement>('[data-reader-text-block], .reader-text');
  if (!textElement) {
    return [atomicSegment(rectBounds(blockElement, rootTop), blockIndex, 0)];
  }

  const textLength = textElement.textContent?.length ?? 0;
  const textSegments = mergeTextLineFragments(textLineFragments(textElement, rootTop), blockIndex);
  const cards = Array.from(blockElement.querySelectorAll<HTMLElement>('[data-definition-card="true"]'));
  const cardRows = mergeCardRows(cards, rootTop);
  const cardSegments = cardRows.map((row) => atomicSegment(row, blockIndex, textLength));
  if (cards.length === 0) {
    const cardGroup = blockElement.querySelector<HTMLElement>(
      '[data-reader-pagination-card-group], [data-testid^="mobile-card-group-"]',
    );
    if (cardGroup) {
      cardSegments.push(atomicSegment(rectBounds(cardGroup, rootTop), blockIndex, textLength));
    }
  }

  if (textSegments.length === 0 && cardSegments.length === 0) {
    return [atomicSegment(rectBounds(blockElement, rootTop), blockIndex, 0)];
  }
  return [...textSegments, ...cardSegments].sort((left, right) =>
    left.startY - right.startY || left.endY - right.endY || left.startOffset - right.startOffset);
}

function readRenderedSegments(root: HTMLElement): ReaderPaginationSegment[] {
  const rootTop = root.getBoundingClientRect().top;
  const markedBlocks = Array.from(root.querySelectorAll<HTMLElement>('[data-reader-block-index]'));
  if (markedBlocks.length === 0) {
    throw readerPaginationMeasurementError('No rendered reader blocks have data-reader-block-index markers.');
  }

  const segments: ReaderPaginationSegment[] = [];
  const seenIndexes = new Set<number>();
  let firstBlockElement: HTMLElement | null = null;
  let firstBlockIndex = -1;
  markedBlocks.forEach((blockElement) => {
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
    if (!firstBlockElement) {
      firstBlockElement = blockElement;
      firstBlockIndex = blockIndex;
    }
    segments.push(...measuredBlockSegments(blockElement, rootTop, blockIndex));
  });
  if (firstBlockElement) {
    segments.push(...leadingPreambleSegments(root, firstBlockElement, firstBlockIndex, rootTop));
  }
  return segments;
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

  return documentOrder.map((element) => atomicSegment(rectBounds(element, rootTop), firstBlockIndex, 0));
}

function segmentsSignature(segments: readonly ReaderPaginationSegment[]): string {
  return segments.map((segment) => [
    segment.blockIndex,
    segment.startOffset,
    segment.endOffset,
    Math.round(segment.startY * 100) / 100,
    Math.round(segment.endY * 100) / 100,
    segment.kind,
  ].join(':')).join('|');
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

async function measureStablePages(
  root: HTMLElement,
  pageHeight: number,
  chapterIndex: number,
  signal: AbortSignal,
): Promise<ReaderPaginationPage[] | null> {
  let previousSignature: string | null = null;
  for (let measurementIndex = 0; measurementIndex < MAX_STABILITY_MEASUREMENTS; measurementIndex += 1) {
    if (signal.aborted) return null;
    const firstMeasurement = readRenderedSegments(root);
    const firstSignature = segmentsSignature(firstMeasurement);
    if (firstSignature === previousSignature) {
      return buildReaderPages(firstMeasurement, pageHeight, chapterIndex);
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
): string {
  const input = JSON.stringify([
    layoutKey,
    chapterIndex,
    Math.round(pageHeight * 100) / 100,
    pages.map((page) => [
      Math.round(page.startY * 100) / 100,
      Math.round(page.endY * 100) / 100,
      page.startLocation.blockIndex,
      page.startLocation.textOffset,
      page.endLocation.blockIndex,
      page.endLocation.textOffset,
      page.issues,
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

function geometryElements(node: Node): Element[] {
  if (!(node instanceof Element)) return [];
  const selector = '[data-reader-block-index], [data-definition-card="true"], img';
  return [
    ...(node.matches(selector) ? [node] : []),
    ...Array.from(node.querySelectorAll(selector)),
  ];
}

/** Keep compatible pages available and remeasure them as rendered chapter geometry changes. */
export function useReaderPagination({
  rootRef,
  enabled,
  settled,
  layoutKey,
  chapterIndex,
  pageHeight,
  anchor,
}: UseReaderPaginationOptions): UseReaderPaginationResult {
  const [layout, setLayout] = useState<ReaderPaginationLayout | null>(null);
  const [measurementError, setMeasurementError] = useState<ReaderPaginationErrorState | null>(null);
  const [settledMeasurementRevision, setSettledMeasurementRevision] = useState(0);
  const settledRef = useRef(settled);
  const layoutRef = useRef<ReaderPaginationLayout | null>(null);
  const scheduleMeasurementRef = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    settledRef.current = settled;
    if (settled) scheduleMeasurementRef.current();
  }, [settled]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) {
      scheduleMeasurementRef.current = () => {};
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
      try {
        const currentLayout = layoutRef.current;
        const needsInitialLayout = currentLayout?.layoutKey !== layoutKey
          || currentLayout.chapterIndex !== chapterIndex
          || currentLayout.pageHeight !== pageHeight;
        const anchorPage = needsInitialLayout
          ? readAnchorPage(root, pageHeight, chapterIndex, anchor)
          : null;
        if (active && anchorPage) {
          const anchorPages = [anchorPage];
          const anchorLayout: ReaderPaginationLayout = {
            chapterIndex,
            layoutKey,
            signature: layoutSignature(layoutKey, chapterIndex, pageHeight, anchorPages),
            pageHeight,
            pages: anchorPages,
          };
          if (layoutRef.current?.layoutKey !== layoutKey
            || layoutRef.current.signature !== anchorLayout.signature) {
            layoutRef.current = anchorLayout;
            setLayout(anchorLayout);
          }
          if (!await waitForNextFrame(controller.signal)
            || !await waitForNextFrame(controller.signal)) return;
        }

        const pages = await measureStablePages(root, pageHeight, chapterIndex, controller.signal);
        if (active && pages) {
          const nextLayout: ReaderPaginationLayout = {
            chapterIndex,
            layoutKey,
            signature: layoutSignature(layoutKey, chapterIndex, pageHeight, pages),
            pageHeight,
            pages,
          };
          if (layoutRef.current?.signature !== nextLayout.signature) {
            layoutRef.current = nextLayout;
            setLayout(nextLayout);
          }
          if (measurementStartedSettled && settledRef.current && !runPending) {
            setSettledMeasurementRevision((revision) => revision + 1);
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
        }
      }
    };

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
    root.querySelectorAll('[data-reader-block-index], [data-definition-card="true"], img')
      .forEach(observeGeometry);
    const mutationObserver = new MutationObserver((records) => {
      let geometryChanged = false;
      records.forEach((record) => {
        if (record.type === 'childList') {
          geometryChanged = true;
          record.addedNodes.forEach(observeTree);
          record.removedNodes.forEach(unobserveTree);
        } else if (record.type === 'characterData') {
          geometryChanged = true;
        }
      });
      if (geometryChanged) scheduleMeasurement();
    });
    mutationObserver.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
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
  const isReady = enabled && error === null
    && layout?.layoutKey === layoutKey
    && layout.chapterIndex === chapterIndex
    && layout.pageHeight === pageHeight;

  return {
    layout,
    isReady,
    error,
    settledMeasurementRevision,
  };
}
