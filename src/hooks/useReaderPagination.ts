import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import {
  buildReaderPages,
  type ReaderPaginationLayout,
  type ReaderPaginationPage,
  type ReaderPaginationSegment,
} from '@/core/reader-pagination';

interface UseReaderPaginationOptions {
  rootRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  settled: boolean;
  layoutKey: string;
  chapterIndex: number;
  pageHeight: number;
}

interface ReaderPaginationErrorState {
  layoutKey: string;
  error: Error;
}

export interface UseReaderPaginationResult {
  layout: ReaderPaginationLayout | null;
  isReady: boolean;
  error: Error | null;
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

export class ReaderPaginationMeasurementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReaderPaginationMeasurementError';
  }
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
    throw new ReaderPaginationMeasurementError(
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
    throw new ReaderPaginationMeasurementError('No rendered reader blocks have data-reader-block-index markers.');
  }

  const segments: ReaderPaginationSegment[] = [];
  const seenIndexes = new Set<number>();
  let firstBlockElement: HTMLElement | null = null;
  let firstBlockIndex = -1;
  markedBlocks.forEach((blockElement) => {
    const blockIndex = Number(blockElement.dataset.readerBlockIndex);
    if (!Number.isInteger(blockIndex) || blockIndex < 0) {
      throw new ReaderPaginationMeasurementError(
        `Rendered reader block has an invalid data-reader-block-index: value=${blockElement.dataset.readerBlockIndex ?? ''}`,
      );
    }
    if (seenIndexes.has(blockIndex)) {
      throw new ReaderPaginationMeasurementError(`Rendered reader block index is duplicated: blockIndex=${blockIndex}`);
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

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    if (signal.aborted) {
      resolve(undefined);
      return;
    }
    const onAbort = (): void => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, (failure: unknown) => {
      signal.removeEventListener('abort', onAbort);
      reject(failure);
    });
  });
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

async function waitForRenderedResources(root: HTMLElement, signal: AbortSignal): Promise<boolean> {
  const imagePromises = Array.from(root.querySelectorAll<HTMLImageElement>('img')).map(async (image) => {
    try {
      await image.decode();
    } catch (failure) {
      if (!image.complete) {
        throw new ReaderPaginationMeasurementError(
          `Reader image did not settle before pagination measurement: src=${image.currentSrc || image.src}, error=${String(failure)}`,
        );
      }
      console.warn('reader-pagination-image-decode-failed', {
        src: image.currentSrc || image.src,
        error: failure,
      });
    }
  });
  const resourcesPromise = Promise.all([document.fonts.ready, ...imagePromises]).then(() => true);
  return (await raceWithAbort(resourcesPromise, signal)) === true;
}

async function measureStablePages(
  root: HTMLElement,
  pageHeight: number,
  chapterIndex: number,
  signal: AbortSignal,
): Promise<ReaderPaginationPage[] | null> {
  const resourcesSettled = await waitForRenderedResources(root, signal);
  if (!resourcesSettled) return null;

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
  throw new ReaderPaginationMeasurementError(
    `Reader layout kept changing during pagination measurement: measurements=${MAX_STABILITY_MEASUREMENTS}`,
  );
}

/** Measure the settled chapter DOM and keep the last committed layout while a new one is prepared. */
export function useReaderPagination({
  rootRef,
  enabled,
  settled,
  layoutKey,
  chapterIndex,
  pageHeight,
}: UseReaderPaginationOptions): UseReaderPaginationResult {
  const [layout, setLayout] = useState<ReaderPaginationLayout | null>(null);
  const [measurementError, setMeasurementError] = useState<ReaderPaginationErrorState | null>(null);
  const [isMeasuring, setIsMeasuring] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !settled || !root) {
      setIsMeasuring(false);
      return;
    }
    if (!Number.isFinite(pageHeight) || pageHeight <= 0) {
      setIsMeasuring(false);
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
      setIsMeasuring(true);
      scheduledFrame = window.requestAnimationFrame(() => {
        scheduledFrame = 0;
        void runMeasurement();
      });
    };

    const runMeasurement = async (): Promise<void> => {
      if (!active || running) return;
      running = true;
      runPending = false;
      setIsMeasuring(true);
      try {
        const pages = await measureStablePages(root, pageHeight, chapterIndex, controller.signal);
        if (active && pages) {
          setLayout({ chapterIndex, layoutKey, pageHeight, pages });
          setMeasurementError(null);
          setIsMeasuring(false);
        }
      } catch (failure) {
        if (active && !controller.signal.aborted) {
          measurementFailed = true;
          const error = failure instanceof Error
            ? failure
            : new ReaderPaginationMeasurementError(`Reader pagination failed: ${String(failure)}`);
          setMeasurementError({ layoutKey, error });
          setIsMeasuring(false);
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
    resizeObserver.observe(root);
    root.querySelectorAll<HTMLElement>(
      '[data-reader-block-index], [data-definition-card="true"], img',
    ).forEach((element) => resizeObserver.observe(element));
    document.fonts.addEventListener('loadingdone', scheduleMeasurement);
    window.addEventListener('resize', scheduleMeasurement);
    scheduleMeasurement();

    return () => {
      active = false;
      controller.abort();
      resizeObserver.disconnect();
      document.fonts.removeEventListener('loadingdone', scheduleMeasurement);
      window.removeEventListener('resize', scheduleMeasurement);
      if (scheduledFrame !== 0) window.cancelAnimationFrame(scheduledFrame);
    };
  }, [rootRef, enabled, settled, layoutKey, chapterIndex, pageHeight]);

  const error = measurementError?.layoutKey === layoutKey ? measurementError.error : null;
  const isReady = enabled && settled && !isMeasuring && error === null
    && layout?.layoutKey === layoutKey
    && layout.chapterIndex === chapterIndex
    && layout.pageHeight === pageHeight;

  return {
    layout,
    isReady,
    error,
  };
}
