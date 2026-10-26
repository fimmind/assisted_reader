import {
  createElement, memo, useState, useEffect, useRef, useLayoutEffect, useCallback, useMemo,
} from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useParams, Link, useLocation } from 'wouter';
import { ChevronLeft, Type, Eye, EyeOff, GraduationCap, MoreHorizontal, Trash2, List, BookmarkPlus, CornerUpLeft, Maximize2, Minimize2 } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useSettings } from '@/hooks/useSettings';
import { useTheme } from '@/components/ThemeProvider';
import { ContextualDefinitionCard } from '@/components/ContextualDefinitionCard';
import type { ScoredDefinition } from '@/components/ContextualDefinitionCard';
import { WordDefinitionCard } from '@/components/WordDefinitionCard';
import { StudyFlow } from '@/components/StudyFlow';
import { ReaderVocabularyTestOnboarding } from '@/components/ReaderVocabularyTestOnboarding';
import type { DefinitionTextSelection, DefinitionWordClick } from '@/components/WordDefinitionCard';
import { marginForReductionLevel, paragraphWindowForWsd, sentenceWindowForWsd, wordNetGlosses } from '@/core/wsd-filter';
import type { WsdContext } from '@/core/wsd-filter';
import { scoreWordSenses, startWsdModel, stopWsdModel, waitForWsdModelReady } from '@/core/wsd-runtime';
import { cn } from '@/lib/utils';
import { deleteBookById, getBookById, listBooks } from '@/core/books-store';
import { saveBookReadingProgress, withBookReadingProgress } from '@/core/reading-progress-store';
import { createReaderBookmark, deleteReaderBookmark, listReaderBookmarks, renameReaderBookmark } from '@/core/reader-bookmarks';
import {
  bookProgressAtLocation,
  captureVisibleReaderLocation,
  chapterProgressAtLocation,
  readerLocationFromLegacyProgress,
  resolveReaderLocation,
  restoreReaderLocation,
} from '@/core/reader-location';
import { readerPageIndexForLocation } from '@/core/reader-pagination';
import type { ReaderPaginationLayout } from '@/core/reader-pagination';
import { ReaderNavigationSheet } from '@/components/ReaderNavigationSheet';
import { useReaderPagination } from '@/hooks/useReaderPagination';
import { WORD_RE } from '@/core/constants';
import { createFallbackLexiconEntry, loadLexicon, resolveLexiconEntry } from '@/core/lexicon';
import {
  areDefinitionTargetsEqual,
  buildDefinitionLookupCandidates,
  createDefinitionTarget,
  definitionTargetKey,
  lookupFirstAvailableDefinition,
} from '@/core/definition-target';
import { adjacentReadingChapter, areInitialReaderCardsReady, chapterTitleForReader, readerAnchorChapter, readerBlocksForChapter } from '@/core/reader-content';
import { normalizeToken } from '@/core/math';
import { loadVocabularyModel } from '@/core/model';
import { loadLemmaDict } from '@/core/lemma';
import { loadCompromise } from '@/core/external';
import type { NlpLike } from '@/core/nlp';
import { analyzeChapter, createCachedChapterAnalyzer, getSessionBookLexicalCache, rankParagraphCardTargets } from '@/core/reader-analysis';
import { getActiveProfile, listenStateUpdated, loadProfileState, upsertObservation } from '@/core/profile-store';
import type { LazyLexicon } from '@/core/lexicon';
import type { DefinitionLookupCandidate } from '@/core/definition-target';
import type { ChapterAnalyzer, LexicalAnalysisCache } from '@/core/reader-analysis';
import type { StudyTextScope } from '@/core/study';
import type {
  BookChapter,
  DefinitionTarget,
  ImportedBook,
  LexiconEntry,
  ParagraphAnalysis,
  PartOfSpeech,
  ReaderInlineMark,
  ReaderContentBlock,
  ReaderBookmark,
  ReaderParagraphBlock,
  ReaderLocation,
  ReaderSettings,
  ReaderTextRun,
  UserProfile,
  VocabularyModel,
} from '@/core/types';

function clampChapterNumber(book: ImportedBook, chapterNumber: number | undefined): number {
  if (typeof chapterNumber !== 'number' || !Number.isFinite(chapterNumber)) {
    return 1;
  }
  const integerChapter = Math.trunc(chapterNumber);
  if (integerChapter < 1) {
    return 1;
  }
  if (integerChapter > book.chapters.length) {
    return book.chapters.length;
  }
  return integerChapter;
}

function clampChapterProgress(progress: number | undefined): number {
  if (typeof progress !== 'number' || !Number.isFinite(progress)) {
    return 0;
  }
  if (progress < 0) {
    return 0;
  }
  if (progress > 1) {
    return 1;
  }
  return progress;
}

function readerLocationsEqual(left: ReaderLocation | null, right: ReaderLocation | null): boolean {
  return left !== null && right !== null
    && left.chapterIndex === right.chapterIndex
    && left.blockIndex === right.blockIndex
    && left.textOffset === right.textOffset;
}

function lastLinearReaderLocation(book: ImportedBook): ReaderLocation {
  let chapterIndex = book.chapters.findLastIndex((chapter) => chapter.linear !== false);
  if (chapterIndex < 0) chapterIndex = 0;
  const chapter = book.chapters[chapterIndex];
  if (!chapter) return { chapterIndex: 0, blockIndex: 0, textOffset: 0 };
  const blocks = readerBlocksForChapter(chapter.paragraphs, chapter.readerBlocks);
  for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
    const block = blocks[blockIndex];
    if (block.type === 'paragraph') {
      return {
        chapterIndex,
        blockIndex,
        textOffset: chapter.paragraphs[block.paragraphIndex]?.length ?? 0,
      };
    }
  }
  return { chapterIndex, blockIndex: Math.max(0, blocks.length - 1), textOffset: 0 };
}

function lastReaderLocationInChapter(book: ImportedBook, chapterIndex: number): ReaderLocation {
  const chapter = book.chapters[chapterIndex];
  if (!chapter) return { chapterIndex, blockIndex: 0, textOffset: 0 };
  const blocks = readerBlocksForChapter(chapter.paragraphs, chapter.readerBlocks);
  for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
    const block = blocks[blockIndex];
    if (block.type === 'paragraph') {
      return {
        chapterIndex,
        blockIndex,
        textOffset: chapter.paragraphs[block.paragraphIndex]?.length ?? 0,
      };
    }
  }
  return { chapterIndex, blockIndex: Math.max(0, blocks.length - 1), textOffset: 0 };
}

function bookmarkLabelAtLocation(book: ImportedBook, location: ReaderLocation): string {
  const chapter = book.chapters[location.chapterIndex];
  if (!chapter) return `Chapter ${location.chapterIndex + 1}`;
  const block = readerBlocksForChapter(chapter.paragraphs, chapter.readerBlocks)[location.blockIndex];
  if (block?.type !== 'paragraph') return chapter.title || `Chapter ${location.chapterIndex + 1}`;
  const text = chapter.paragraphs[block.paragraphIndex] ?? '';
  if (!text) return chapter.title || `Chapter ${location.chapterIndex + 1}`;
  const start = Math.max(0, location.textOffset - 28);
  const snippet = text.slice(start, start + 64).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${snippet}${start + 64 < text.length ? '…' : ''}`;
}

function measureVisibleReaderParagraphs(
  paragraphElements: Array<HTMLElement | null>,
  paragraphCount: number,
  viewportHeight: number,
): number[] {
  return paragraphElements.flatMap((paragraph, index) => {
    if (!paragraph || index >= paragraphCount) return [];
    const wrapper = paragraph.parentElement;
    if (!wrapper) return [];
    const bounds = wrapper.getBoundingClientRect();
    return bounds.top < viewportHeight && bounds.bottom > 0 ? [index] : [];
  });
}

interface ReaderResources {
  model: VocabularyModel;
  lemmaDict: Record<string, string>;
  lexicon: LazyLexicon;
  nlp: NlpLike | null;
  lexicalAnalysisCache: LexicalAnalysisCache;
}

interface PreparedChapterOpening {
  bookId: string;
  bookUpdatedAt: string;
  chapterIndex: number;
  chapter: BookChapter;
  layoutKey: string;
  settingsKey: string;
  profileKey: string;
  analyses: Map<number, ParagraphAnalysis>;
  scores: Map<string, ScoredDefinition>;
  readyCards: Set<string>;
  analysisComplete: boolean;
  cardPreloadComplete: boolean;
  viewportWidth: number;
  viewportHeight: number;
  layout: ReaderPaginationLayout | null;
  previewError: Error | null;
}

type PreparedCardReadinessChange = (paragraphIndex: number, targetKey: string, ready: boolean) => void;

interface WordPopupState {
  id: number;
  lookupCandidates: DefinitionLookupCandidate[];
  target: DefinitionTarget;
  lookupWord: string;
  triggerSelection: DefinitionTextSelection | null;
  definition: LexiconEntry | null;
  definitionStatus: DefinitionLoadStatus;
  top: number;
  left: number;
  anchorRect: PopupAnchorRect;
  horizontalAnchorRect: PopupAnchorRect;
  sourceParagraphIndex: number;
  contextText: string;
  contextStart: number;
  contextEnd: number;
  contextIsBookParagraph: boolean;
  originalContext: WsdContext | null;
  parentContexts: readonly string[];
}

type DefinitionLoadStatus = 'loading' | 'ready' | 'error';

interface PopupAnchorRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface PageSwipeStart {
  pointerId: number;
  x: number;
  y: number;
}

interface ReaderActivityIndicatorProps {
  ariaLabel: string;
  testId: string;
}

interface ReaderParagraphTextProps {
  analysis: ParagraphAnalysis;
  block: ReaderParagraphBlock;
  assistanceEnabled: boolean;
  includeDocumentIds: boolean;
  loadingImagesEager: boolean;
  sourceParagraphIndex: number;
  visibleParagraphIndex: number;
  onElementChange: (visibleParagraphIndex: number, element: HTMLElement | null) => void;
  onOpenWordPopup: (
    anchorRect: PopupAnchorRect,
    lookupCandidates: DefinitionLookupCandidate[],
    sourceParagraphIndex: number,
    contextText: string,
  ) => void;
}

interface ParagraphWordClick {
  anchorRect: PopupAnchorRect;
  end: number;
  start: number;
}

interface PageRefreshAnchor {
  location: ReaderLocation;
  layout: ReaderPaginationLayout;
  settledMeasurementRevision: number;
}

type AnalysisRefreshMode = 'reset' | 'preserve';
type ReaderChapterEntryDirection = 'first' | 'last' | 'anchor' | null;

function contextForCard(analysis: ParagraphAnalysis, target: DefinitionTarget): WsdContext | null {
  const key = definitionTargetKey(target);
  const token = analysis.tokens.find((candidate) =>
    definitionTargetKey(createDefinitionTarget(candidate.lemma, candidate.partOfSpeech)) === key);
  return token
    ? { text: analysis.paragraphText, start: token.start, end: token.end }
    : null;
}

type DeferredHandle = {
  kind: 'idle' | 'timeout';
  id: number;
};

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

function ReaderActivityIndicator({ ariaLabel, testId }: ReaderActivityIndicatorProps) {
  return (
    <div role="status" aria-label={ariaLabel} aria-live="polite" data-testid={testId}>
      <span
        aria-hidden="true"
        className="block size-5 rounded-full border-2 border-current border-t-transparent animate-spin will-change-transform [animation-duration:1200ms]"
      />
    </div>
  );
}

const MAX_PRELOAD_PARAGRAPHS = 32;
const MAX_PRELOAD_CARDS = 64;
const MAX_PRELOAD_CHARACTERS = 12000;
const ANALYSIS_TIME_SLICE_MS = 8;
const ANALYSIS_PUBLISH_INTERVAL_MS = 1000;
const ANALYSIS_SCROLL_SETTLE_MS = 150;
const ANALYSIS_SCROLL_POLL_MS = 16;
const SCROLL_KEYS: ReadonlySet<string> = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' ']);

function clearDeferredHandle(handle: DeferredHandle | null): void {
  if (!handle) {
    return;
  }
  const idleWindow = window as IdleWindow;
  if (handle.kind === 'idle' && typeof idleWindow.cancelIdleCallback === 'function') {
    idleWindow.cancelIdleCallback(handle.id);
    return;
  }
  window.clearTimeout(handle.id);
}

function scheduleDeferredTask(task: () => void, timeoutMs: number): DeferredHandle {
  const idleWindow = window as IdleWindow;
  if (typeof idleWindow.requestIdleCallback === 'function') {
    const id = idleWindow.requestIdleCallback(task, { timeout: timeoutMs });
    return { kind: 'idle', id };
  }
  const id = window.setTimeout(task, timeoutMs);
  return { kind: 'timeout', id };
}

function yieldForAnalysisContinuation(): Promise<void> {
  return new Promise<void>((resolve) => {
    const idleWindow = window as IdleWindow;
    if (typeof idleWindow.requestIdleCallback === 'function') {
      idleWindow.requestIdleCallback(resolve);
      return;
    }
    window.setTimeout(resolve, 0);
  });
}

function yieldForReaderPrerenderContinuation(): Promise<void> {
  return new Promise<void>((resolve) => {
    const idleWindow = window as IdleWindow;
    if (typeof idleWindow.requestIdleCallback === 'function') {
      idleWindow.requestIdleCallback(resolve, { timeout: 100 });
      return;
    }
    window.setTimeout(resolve, 0);
  });
}

function capturePopupAnchorRect(rect: DOMRect): PopupAnchorRect {
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
  };
}

function resolveCaretTextPosition(clientX: number, clientY: number): { node: Text; offset: number } | null {
  const caretDocument = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const caretPosition = caretDocument.caretPositionFromPoint?.(clientX, clientY);
  if (caretPosition?.offsetNode instanceof Text) {
    return { node: caretPosition.offsetNode, offset: caretPosition.offset };
  }
  const caretRange = caretDocument.caretRangeFromPoint?.(clientX, clientY);
  if (caretRange?.startContainer instanceof Text) {
    return { node: caretRange.startContainer, offset: caretRange.startOffset };
  }
  return null;
}

function resolveTextNodeStartOffset(container: HTMLElement, targetNode: Text): number | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let node = walker.nextNode();
  while (node) {
    if (node === targetNode) {
      return offset;
    }
    offset += node.textContent?.length ?? 0;
    node = walker.nextNode();
  }
  return null;
}

function resolveTextPosition(
  container: HTMLElement,
  offset: number,
  boundary: 'start' | 'end',
): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  let nodeStart = 0;
  let lastNode: Text | null = null;
  while (node) {
    const nodeEnd = nodeStart + node.length;
    if (boundary === 'start' ? offset < nodeEnd || offset === nodeStart : offset <= nodeEnd) {
      return { node, offset: Math.max(0, Math.min(offset - nodeStart, node.length)) };
    }
    nodeStart = nodeEnd;
    lastNode = node;
    node = walker.nextNode() as Text | null;
  }
  return lastNode && offset === nodeStart ? { node: lastNode, offset: lastNode.length } : null;
}

function resolveParagraphWordClick(
  paragraphElement: HTMLElement,
  paragraphText: string,
  clientX: number,
  clientY: number,
): ParagraphWordClick | null {
  const caret = resolveCaretTextPosition(clientX, clientY);
  if (!caret || !paragraphElement.contains(caret.node)) {
    return null;
  }
  const nodeStart = resolveTextNodeStartOffset(paragraphElement, caret.node);
  if (nodeStart === null) {
    return null;
  }
  const clickedOffset = nodeStart + caret.offset;
  const matcher = new RegExp(WORD_RE.source, WORD_RE.flags);
  let selectedMatch: RegExpExecArray | null = null;
  let match = matcher.exec(paragraphText);
  while (match) {
    const matchEnd = match.index + match[0].length;
    if (
      (clickedOffset >= match.index && clickedOffset < matchEnd)
      || (clickedOffset === matchEnd && clickedOffset > match.index)
    ) {
      selectedMatch = match;
      break;
    }
    if (match.index > clickedOffset) {
      break;
    }
    match = matcher.exec(paragraphText);
  }
  if (!selectedMatch) {
    return null;
  }

  const start = selectedMatch.index;
  const end = start + selectedMatch[0].length;
  const startPosition = resolveTextPosition(paragraphElement, start, 'start');
  const endPosition = resolveTextPosition(paragraphElement, end, 'end');
  if (!startPosition || !endPosition) return null;
  const range = document.createRange();
  range.setStart(startPosition.node, startPosition.offset);
  range.setEnd(endPosition.node, endPosition.offset);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return null;
  }
  return { anchorRect: capturePopupAnchorRect(rect), start, end };
}

function calculateWordPopupPosition(
  anchorRect: PopupAnchorRect,
  horizontalAnchorRect: PopupAnchorRect,
  popupWidth: number,
  popupHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): { top: number; left: number } {
  const edgePadding = 8;
  const sideOffset = 8;
  const boundedPopupWidth = Math.min(popupWidth, viewportWidth - (edgePadding * 2));
  const boundedPopupHeight = Math.min(popupHeight, viewportHeight - (edgePadding * 2));

  let left = horizontalAnchorRect.right + sideOffset;
  if (left + boundedPopupWidth > viewportWidth - edgePadding) {
    left = horizontalAnchorRect.left - boundedPopupWidth - sideOffset;
  }
  left = Math.max(edgePadding, Math.min(left, viewportWidth - boundedPopupWidth - edgePadding));

  let top = anchorRect.top;
  if (top + boundedPopupHeight > viewportHeight - edgePadding) {
    top = anchorRect.bottom - boundedPopupHeight;
  }
  top = Math.max(edgePadding, Math.min(top, viewportHeight - boundedPopupHeight - edgePadding));

  return { top, left };
}

function calculateWordLookupIndicatorPosition(
  anchorRect: PopupAnchorRect,
  viewportWidth: number,
  viewportHeight: number,
): { top: number; left: number } {
  const edgePadding = 8;
  const sideOffset = 6;
  const indicatorSize = 20;
  let left = anchorRect.right + sideOffset;
  if (left + indicatorSize > viewportWidth - edgePadding) {
    left = anchorRect.left - indicatorSize - sideOffset;
  }
  left = Math.max(edgePadding, Math.min(left, viewportWidth - indicatorSize - edgePadding));
  const centeredTop = anchorRect.top + ((anchorRect.bottom - anchorRect.top - indicatorSize) / 2);
  const top = Math.max(edgePadding, Math.min(centeredTop, viewportHeight - indicatorSize - edgePadding));
  return { top, left };
}

const ReaderParagraphText = memo(function ReaderParagraphText({
  analysis,
  block,
  assistanceEnabled,
  includeDocumentIds,
  loadingImagesEager,
  sourceParagraphIndex,
  visibleParagraphIndex,
  onElementChange,
  onOpenWordPopup,
}: ReaderParagraphTextProps) {
  const highlightedTargetKeys = assistanceEnabled
    ? new Set<string>(analysis.cardTargets.map((target) => definitionTargetKey(target)))
    : new Set<string>();
  const tokenByRange = new Map<string, ParagraphAnalysis['tokens'][number]>();
  for (const token of analysis.tokens) {
    tokenByRange.set(`${token.start}:${token.end}`, token);
  }

  const nodes: ReactNode[] = [];
  const richContent = block.content.length > 0
    ? block.content
    : [{ type: 'text' as const, text: analysis.paragraphText, marks: [] as ReaderInlineMark[] }];
  const highlightedRanges = analysis.tokens.flatMap((analyzedToken) => {
    const target = createDefinitionTarget(analyzedToken.lemma, analyzedToken.partOfSpeech);
    const shouldHighlight = assistanceEnabled
      && analyzedToken.unknown
      && highlightedTargetKeys.has(definitionTargetKey(target));
    return shouldHighlight ? [analyzedToken] : [];
  });

  const formatRunText = (text: string, run: ReaderTextRun, key: string): ReactNode => {
    let result: ReactNode = text;
    const runStyle = run.style as CSSProperties | undefined;
    if (runStyle && Object.keys(runStyle).length > 0) {
      result = <span style={runStyle}>{result}</span>;
    }
    const markTags: Record<ReaderInlineMark, string> = {
      strong: 'strong',
      emphasis: 'em',
      underline: 'u',
      strike: 's',
      subscript: 'sub',
      superscript: 'sup',
      code: 'code',
      mark: 'mark',
      small: 'small',
      big: 'big',
    };
    for (const mark of [...run.marks].reverse()) {
      result = createElement(markTags[mark], { key: `${key}-${mark}` }, result);
    }
    if (run.href) {
      const external = /^https?:/i.test(run.href);
      return <a key={key} href={run.href} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}>{result}</a>;
    }
    return <span key={key}>{result}</span>;
  };

  let paragraphOffset = 0;
  richContent.forEach((content, contentIndex) => {
    if (content.type === 'image') {
      nodes.push(
        <img
          key={`inline-image-${contentIndex}`}
          src={content.src}
          alt={content.alt}
          title={content.title}
          className="inline-block max-w-full align-middle"
          style={content.style as CSSProperties | undefined}
          loading={loadingImagesEager ? 'eager' : 'lazy'}
        />,
      );
      return;
    }
    const runStart = paragraphOffset;
    const runEnd = runStart + content.text.length;
    const run = content;
    if (run.lineBreakBefore) nodes.push(<br key={`line-break-${contentIndex}`} />);
    let cursor = runStart;
    for (const analyzedToken of highlightedRanges) {
      if (analyzedToken.end <= runStart || analyzedToken.start >= runEnd) continue;
      const tokenStart = Math.max(runStart, analyzedToken.start);
      const tokenEnd = Math.min(runEnd, analyzedToken.end);
      if (tokenStart > cursor) {
        nodes.push(formatRunText(run.text.slice(cursor - runStart, tokenStart - runStart), run, `text-${contentIndex}-${cursor}`));
      }
      const target = createDefinitionTarget(analyzedToken.lemma, analyzedToken.partOfSpeech);
      const isPriority = (1 - analyzedToken.pKnown) > 0.6;
      const highlightedText = run.text.slice(tokenStart - runStart, tokenEnd - runStart);
      const formattedHighlight = formatRunText(highlightedText, run, `highlight-${contentIndex}-${tokenStart}`);
      nodes.push(
        <span
          key={`${analyzedToken.lemma}-${analyzedToken.start}-${contentIndex}`}
          data-word-popup-trigger="true"
          data-reader-selected-target={readerTargetDomKey(target, sourceParagraphIndex)}
          className={cn(
            'cursor-pointer rounded-sm px-0.5 -mx-0.5',
            isPriority ? 'unknown-word priority' : 'unknown-word',
          )}
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest('a')) return;
            const lookupCandidates = buildDefinitionLookupCandidates(
              analysis.paragraphText,
              analyzedToken.start,
              analyzedToken.end,
              target,
            );
            onOpenWordPopup(
              capturePopupAnchorRect(event.currentTarget.getBoundingClientRect()),
              lookupCandidates,
              sourceParagraphIndex,
              analysis.paragraphText,
            );
          }}
        >
          {formattedHighlight}
        </span>,
      );
      cursor = tokenEnd;
    }
    if (cursor < runEnd) {
      nodes.push(formatRunText(run.text.slice(cursor - runStart), run, `text-${contentIndex}-${cursor}`));
    }
    paragraphOffset = runEnd;
  });

  const blockTag = block.blockType === 'heading'
    ? `h${block.level ?? 2}`
    : block.blockType === 'pre' ? 'pre'
      : block.blockType === 'blockquote' ? 'blockquote' : 'p';
  const blockStyle: CSSProperties = {
    ...(block.blockType === 'heading' ? {
      fontSize: block.level === 1 ? '1.5em' : block.level === 2 ? '1.35em' : '1.2em',
      fontWeight: 500,
      lineHeight: 1.25,
      marginBlock: '1em 0.5em',
    } : {}),
    ...(block.blockType === 'blockquote' ? { marginBlock: '1em', marginInline: '1.5em' } : {}),
    ...(block.blockType === 'pre' ? { whiteSpace: 'pre-wrap', overflowX: 'auto' } : {}),
    ...(block.blockType === 'verse' ? { whiteSpace: 'pre-line' } : {}),
    ...(block.style as CSSProperties | undefined),
    ...(block.blockType === 'list-item' ? { display: 'list-item', listStyleType: 'none', marginInlineStart: block.style?.marginInlineStart ?? '1.5em' } : {}),
  };
  const blockClass = cn(
    'text-foreground/90 reader-text cursor-pointer',
    block.blockType === 'heading' && 'reader-imported-heading',
    block.blockType === 'list-item' && 'reader-list-item',
    block.blockType === 'verse' && 'reader-verse',
    block.blockType === 'pre' && 'reader-pre',
    block.blockType === 'blockquote' && 'reader-blockquote',
  );

  return (
    <>
      {block.anchorIds?.map((anchorId) => (
        <span key={anchorId} id={includeDocumentIds ? anchorId : undefined} className="reader-anchor" />
      ))}
      {createElement(
        blockTag,
        {
          ref: (element: HTMLElement | null) => onElementChange(visibleParagraphIndex, element),
          className: blockClass,
          style: blockStyle,
          'data-testid': includeDocumentIds ? `paragraph-${visibleParagraphIndex}` : undefined,
          'data-reader-text-block': '',
          'data-reader-list-marker': block.listMarker,
          onClick: (event: ReactMouseEvent<HTMLElement>) => {
            const clickedTrigger = event.target instanceof Element
              ? event.target.closest('[data-word-popup-trigger="true"]')
              : null;
            if (clickedTrigger || (event.target instanceof Element && event.target.closest('a'))) {
              return;
            }
            const click = resolveParagraphWordClick(
              event.currentTarget,
              analysis.paragraphText,
              event.clientX,
              event.clientY,
            );
            if (!click) {
              return;
            }
            const analyzedToken = tokenByRange.get(`${click.start}:${click.end}`);
            const rawWord = analysis.paragraphText.slice(click.start, click.end);
            const target = createDefinitionTarget(
              analyzedToken?.lemma ?? normalizeToken(rawWord),
              analyzedToken?.partOfSpeech ?? null,
            );
            const lookupCandidates = buildDefinitionLookupCandidates(
              analysis.paragraphText,
              click.start,
              click.end,
              target,
            );
            onOpenWordPopup(click.anchorRect, lookupCandidates, sourceParagraphIndex, analysis.paragraphText);
          },
        },
        nodes.length > 0 ? nodes : analysis.paragraphText,
      )}
    </>
  );
});

interface ReaderBlockPresentation {
  offset: number;
  fragmentTop: number | undefined;
  fragmentBottom: number | undefined;
  clipPath: string | undefined;
  visibility: CSSProperties['visibility'];
}

interface ReaderChapterBlockListProps {
  paragraphs: readonly string[];
  blocks: readonly ReaderContentBlock[];
  analyses: readonly ParagraphAnalysis[];
  assistanceEnabled: boolean;
  pageMode: boolean;
  pageHeight: number;
  includeDocumentIds: boolean;
  loadingImagesEager: boolean;
  presentationForBlock: (blockIndex: number) => ReaderBlockPresentation;
  renderParagraphSupplement: (sourceIndex: number, analysis: ParagraphAnalysis) => ReactNode;
  onElementChange: (visibleParagraphIndex: number, element: HTMLElement | null) => void;
  onOpenWordPopup: ReaderParagraphTextProps['onOpenWordPopup'];
}

interface ReaderDefinitionCardTargetProps {
  sourceChapter: BookChapter | undefined;
  sourceParagraphs: readonly string[];
  preparedOpening: PreparedChapterOpening | null;
  sourceIndex: number;
  analysis: ParagraphAnalysis;
  target: DefinitionTarget;
  active: boolean;
  definitionsByLemma: ReadonlyMap<string, LexiconEntry>;
  loadingDefinitionLemmas: ReadonlySet<string>;
  failedDefinitionLemmas: ReadonlySet<string>;
  observationLabels: UserProfile['observations'];
  settings: ReaderSettings;
  activeDefinitionSelection: DefinitionTextSelection | undefined;
  onReadinessChange: PreparedCardReadinessChange;
  onDefinitionWordClick: (click: DefinitionWordClick) => void;
  onMarkKnown: () => void;
  onMarkUnknown: () => void;
  getPriorityTarget: ((index: number) => HTMLElement | null) | undefined;
}

function ReaderDefinitionCardTarget({
  sourceChapter,
  sourceParagraphs,
  preparedOpening,
  sourceIndex,
  analysis,
  target,
  active,
  definitionsByLemma,
  loadingDefinitionLemmas,
  failedDefinitionLemmas,
  observationLabels,
  settings,
  activeDefinitionSelection,
  onReadinessChange,
  onDefinitionWordClick,
  onMarkKnown,
  onMarkUnknown,
  getPriorityTarget,
}: ReaderDefinitionCardTargetProps) {
  const rawDefinition = definitionsByLemma.get(target.lemma) ?? createFallbackLexiconEntry(target.lemma);
  const definition = resolveLexiconEntry(rawDefinition, target);
  const definitionStatus: DefinitionLoadStatus = loadingDefinitionLemmas.has(target.lemma)
    ? 'loading'
    : failedDefinitionLemmas.has(target.lemma) ? 'error' : 'ready';
  const observation = observationLabels[target.lemma];
  const sharedCardProps = {
    activeDefinitionSelection,
    fontSize: settings.fontSize,
    onDefinitionWordClick,
    onMarkKnown,
    onMarkUnknown,
    isMarkedKnown: observation === 1,
    isMarkedUnknown: observation === 0,
    pronunciationVariant: settings.englishVariant,
    compact: true,
  };
  return (
    <div
      key={readerTargetDomKey(target, sourceIndex)}
      className="w-[266px] shrink-0 [&>[data-definition-card]]:w-[250px]"
      data-reader-card-target={readerTargetDomKey(target, sourceIndex)}
      aria-hidden={!active}
      inert={!active}
      style={active ? undefined : { position: 'absolute', left: '-10000px', visibility: 'hidden' }}
    >
      <ContextualDefinitionCard
        preparedScores={preparedOpening && preparedOpening.chapter === sourceChapter
          ? preparedOpening.scores.get(`${sourceIndex}:${definitionTargetKey(target)}`)
          : undefined}
        onReadinessChange={(ready) => onReadinessChange(sourceIndex, definitionTargetKey(target), ready)}
        definition={definition}
        context={contextForCard(analysis, target)}
        contextParagraphs={sourceParagraphs}
        contextParagraphIndex={sourceIndex}
        wsdMode={settings.wsdMode}
        wsdPriority="card"
        getPriorityTarget={getPriorityTarget}
        priorityTargetIndex={sourceIndex}
        wsdMargin={settings.wsdMode === 'none' ? 0 : marginForReductionLevel(settings.wsdReductionLevel, settings.wsdMode)}
        wsdContextUnit={settings.wsdContextUnit}
        wsdContextSize={settings.wsdContextSize}
        definitionStatus={definitionStatus}
        pendingIndicator={<WordDefinitionCard definition={definition} definitionStatus="loading" {...sharedCardProps} />}
        {...sharedCardProps}
      />
    </div>
  );
}

const ReaderChapterBlockList = memo(function ReaderChapterBlockList({
  paragraphs,
  blocks,
  analyses,
  assistanceEnabled,
  pageMode,
  pageHeight,
  includeDocumentIds,
  loadingImagesEager,
  presentationForBlock,
  renderParagraphSupplement,
  onElementChange,
  onOpenWordPopup,
}: ReaderChapterBlockListProps) {
  return blocks.map((block, blockIndex) => {
    const presentation = presentationForBlock(blockIndex);
    const blockPresentationProps = {
      'data-reader-pagination-offset': presentation.offset,
      'data-reader-page-fragment-top': presentation.fragmentTop,
      'data-reader-page-fragment-bottom': presentation.fragmentBottom,
      style: pageMode ? {
        translate: `0 ${presentation.offset}px`,
        clipPath: presentation.clipPath,
        visibility: presentation.visibility,
      } as CSSProperties : undefined,
    };
    if (block.type === 'image') {
      return (
        <figure key={`reader-image-${blockIndex}`} {...blockPresentationProps} data-reader-block-index={blockIndex} className="my-6 w-full">
          {block.anchorIds?.map((id) => (
            <span key={id} id={includeDocumentIds ? id : undefined} className="reader-anchor" />
          ))}
          <img
            src={block.src}
            alt={block.alt}
            title={block.title}
            className="mx-auto block max-w-full"
            style={pageMode
              ? { ...block.style, maxHeight: `${Math.max(1, pageHeight - 4)}px`, objectFit: 'contain' } as CSSProperties
              : block.style as CSSProperties | undefined}
            loading={pageMode ? 'eager' : 'lazy'}
          />
        </figure>
      );
    }
    if (block.type === 'spacer') {
      return (
        <div key={`reader-spacer-${blockIndex}`} {...blockPresentationProps} data-reader-block-index={blockIndex} aria-hidden="true" style={{ height: '1em', ...block.style, ...(blockPresentationProps.style ?? {}) } as CSSProperties}>
          {block.anchorIds?.map((id) => (
            <span key={id} id={includeDocumentIds ? id : undefined} className="reader-anchor" />
          ))}
        </div>
      );
    }
    if (block.type === 'rule') {
      return (
        <div key={`reader-rule-${blockIndex}`} {...blockPresentationProps} data-reader-block-index={blockIndex}>
          {block.anchorIds?.map((id) => (
            <span key={id} id={includeDocumentIds ? id : undefined} className="reader-anchor" />
          ))}
          <hr className="my-8 border-border" style={block.style as CSSProperties | undefined} />
        </div>
      );
    }
    const sourceIndex = block.paragraphIndex;
    const paragraphText = paragraphs[sourceIndex] ?? '';
    const analysis = analyses[sourceIndex] ?? { paragraphText, tokens: [], cardTargets: [] };
    return (
      <div
        key={`paragraph-${sourceIndex}`}
        {...blockPresentationProps}
        className="mb-2"
        data-reader-block-index={blockIndex}
        data-testid={includeDocumentIds ? `paragraph-block-${sourceIndex}` : undefined}
      >
        <ReaderParagraphText
          analysis={analysis}
          block={block}
          assistanceEnabled={assistanceEnabled}
          includeDocumentIds={includeDocumentIds}
          loadingImagesEager={loadingImagesEager}
          sourceParagraphIndex={sourceIndex}
          visibleParagraphIndex={sourceIndex}
          onElementChange={onElementChange}
          onOpenWordPopup={onOpenWordPopup}
        />
        {renderParagraphSupplement(sourceIndex, analysis)}
      </div>
    );
  });
});

interface ReaderChapterPrerenderProps {
  entry: PreparedChapterOpening;
  layoutKey: string;
  pageHeight: number;
  pageWidthClass: string;
  textFontClass: string;
  settings: ReaderSettings;
  assistanceEnabled: boolean;
  definitionsByLemma: ReadonlyMap<string, LexiconEntry>;
  loadingDefinitionLemmas: ReadonlySet<string>;
  failedDefinitionLemmas: ReadonlySet<string>;
  observationLabels: UserProfile['observations'];
  onLayoutReady: (entry: PreparedChapterOpening, layout: ReaderPaginationLayout) => void;
  onError: (entry: PreparedChapterOpening, error: Error) => void;
}

function ignoreParagraphElementChange(): void {}

function ignoreRootWordPopup(): void {}

function ignoreDefinitionWordClick(): void {}

function ignoreCardAction(): void {}

function noParagraphSupplement(): ReactNode {
  return null;
}

function prerenderBlockPresentation(): ReaderBlockPresentation {
  return { offset: 0, fragmentTop: undefined, fragmentBottom: undefined, clipPath: undefined, visibility: undefined };
}

function decodeReaderImage(image: HTMLImageElement): Promise<void> {
  if (image.complete) {
    if (image.naturalWidth === 0) {
      return Promise.reject(new Error(`Reader prerender image failed to load: src=${image.currentSrc || image.src}`));
    }
    return image.decode();
  }
  return new Promise<void>((resolve, reject) => {
    const handleLoad = (): void => {
      image.removeEventListener('error', handleError);
      void image.decode().then(resolve, reject);
    };
    const handleError = (): void => {
      image.removeEventListener('load', handleLoad);
      reject(new Error(`Reader prerender image failed to load: src=${image.currentSrc || image.src}`));
    };
    image.addEventListener('load', handleLoad, { once: true });
    image.addEventListener('error', handleError, { once: true });
  });
}

const ReaderChapterPrerender = memo(function ReaderChapterPrerender({
  entry,
  layoutKey,
  pageHeight,
  pageWidthClass,
  textFontClass,
  settings,
  assistanceEnabled,
  definitionsByLemma,
  loadingDefinitionLemmas,
  failedDefinitionLemmas,
  observationLabels,
  onLayoutReady,
  onError,
}: ReaderChapterPrerenderProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [assetsReady, setAssetsReady] = useState(false);
  const [readyCardKeys, setReadyCardKeys] = useState<Set<string>>(new Set());
  const chapterParagraphs = entry.chapter.paragraphs;
  const chapterBlocks = useMemo(() => readerBlocksForChapter(chapterParagraphs, entry.chapter.readerBlocks), [entry.chapter]);
  const analyses = useMemo(() => chapterParagraphs.map((paragraphText, index) =>
    entry.analyses.get(index) ?? { paragraphText, tokens: [], cardTargets: [] }), [chapterParagraphs, entry.analyses]);
  const cardReadinessKeys = useMemo(() => analyses.flatMap((analysis, paragraphIndex) =>
    analysis.cardTargets.map((target) => `${paragraphIndex}:${definitionTargetKey(target)}`)), [analyses]);
  const allCardsReady = cardReadinessKeys.every((key) => readyCardKeys.has(key));
  const measurementReady = entry.analysisComplete && assetsReady && allCardsReady;
  const markCardReady = useCallback((paragraphIndex: number, targetKey: string, ready: boolean): void => {
    const key = `${paragraphIndex}:${targetKey}`;
    entry.readyCards[ready ? 'add' : 'delete'](key);
    setReadyCardKeys((previous) => {
      if (previous.has(key) === ready) return previous;
      const next = new Set(previous);
      if (ready) next.add(key);
      else next.delete(key);
      return next;
    });
  }, [entry]);
  const getMeasurementKey = useCallback((layout: ReaderPaginationLayout | null): string | null => {
    if (!measurementReady || !layout || layout.layoutKey !== layoutKey) return null;
    return JSON.stringify([layoutKey, entry.chapterIndex, cardReadinessKeys]);
  }, [cardReadinessKeys, entry.chapterIndex, layoutKey, measurementReady]);
  const pagination = useReaderPagination({
    rootRef,
    initialLayout: null,
    enabled: settings.readingMode === 'page' && measurementReady,
    settled: measurementReady,
    getMeasurementKey,
    layoutKey,
    chapterIndex: entry.chapterIndex,
    pageHeight,
    anchor: null,
  });
  const measuredKey = getMeasurementKey(pagination.layout);
  const previewReady = pagination.isReady && measuredKey !== null && pagination.measuredMeasurementKey === measuredKey;

  useEffect(() => {
    if (!entry.analysisComplete) return;
    const root = rootRef.current;
    if (!root) throw new Error(`Reader prerender has no root: chapterIndex=${entry.chapterIndex}`);
    let active = true;
    void Promise.all(Array.from(root.querySelectorAll<HTMLImageElement>('img'), decodeReaderImage))
      .then(() => document.fonts.ready)
      .then(() => {
        if (active) setAssetsReady(true);
      })
      .catch((failure: unknown) => {
        if (!active) return;
        const error = failure instanceof Error ? failure : new Error(`Reader prerender assets failed: ${String(failure)}`);
        onError(entry, error);
      });
    return () => {
      active = false;
    };
  }, [entry, onError]);

  useEffect(() => {
    if (!previewReady || !pagination.layout) return;
    onLayoutReady(entry, pagination.layout);
  }, [entry, onLayoutReady, pagination.layout, previewReady]);

  useEffect(() => {
    if (!pagination.error) return;
    onError(entry, pagination.error);
  }, [entry, onError, pagination.error]);

  return (
    <div
      className={cn('fixed inset-x-0 top-0 mx-auto px-4 sm:px-6', pageWidthClass)}
      style={{
        height: `${pageHeight}px`,
        overflowY: 'hidden',
        transform: 'translateX(-200vw)',
        visibility: 'hidden',
        pointerEvents: 'none',
      }}
      aria-hidden="true"
      inert
      data-reader-prerender-chapter={entry.chapterIndex}
      data-reader-prerender-ready={previewReady ? 'true' : 'false'}
    >
      <div
        data-reader-pagination-host=""
        style={{
          minHeight: '1px',
          position: 'relative',
          '--reader-page-height': `${pageHeight}px`,
          '--reader-page-card-height': `${Math.min(240, pageHeight * 0.35)}px`,
        } as CSSProperties}
      >
        <div ref={rootRef} className="relative flex min-w-0 flex-1 flex-col reader-page-content">
          {chapterTitleForReader(entry.chapter, entry.chapterIndex + 1) && (
            <h1 className="text-3xl md:text-5xl font-medium mb-12 text-center text-foreground/90 font-serif">
              {chapterTitleForReader(entry.chapter, entry.chapterIndex + 1)}
            </h1>
          )}
          <div className={textFontClass} style={{ fontSize: `${settings.fontSize}px` }}>
            <ReaderChapterBlockList
              paragraphs={chapterParagraphs}
              blocks={chapterBlocks}
              analyses={analyses}
              assistanceEnabled={assistanceEnabled}
              pageMode
              pageHeight={pageHeight}
              includeDocumentIds={false}
              loadingImagesEager
              presentationForBlock={prerenderBlockPresentation}
              renderParagraphSupplement={noParagraphSupplement}
              onElementChange={ignoreParagraphElementChange}
              onOpenWordPopup={ignoreRootWordPopup}
            />
          </div>
        </div>
        {assistanceEnabled && chapterBlocks.map((block) => {
          if (block.type !== 'paragraph') return null;
          const sourceIndex = block.paragraphIndex;
          const analysis = analyses[sourceIndex];
          if (!analysis || analysis.cardTargets.length === 0) return null;
          return (
            <div key={`preview-card-group-${sourceIndex}`} className="reader-page-card-measurements" aria-hidden="true" inert>
              {analysis.cardTargets.map((target) => (
                <ReaderDefinitionCardTarget
                  key={readerTargetDomKey(target, sourceIndex)}
                  sourceChapter={entry.chapter}
                  sourceParagraphs={chapterParagraphs}
                  preparedOpening={entry}
                  sourceIndex={sourceIndex}
                  analysis={analysis}
                  target={target}
                  active={false}
                  definitionsByLemma={definitionsByLemma}
                  loadingDefinitionLemmas={loadingDefinitionLemmas}
                  failedDefinitionLemmas={failedDefinitionLemmas}
                  observationLabels={observationLabels}
                  settings={settings}
                  activeDefinitionSelection={undefined}
                  onReadinessChange={markCardReady}
                  onDefinitionWordClick={ignoreDefinitionWordClick}
                  onMarkKnown={ignoreCardAction}
                  onMarkUnknown={ignoreCardAction}
                  getPriorityTarget={undefined}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
});

function calculateScrollProgressFromDocument(): number {
  const documentElement = document.documentElement;
  const maxScrollTop = Math.max(0, documentElement.scrollHeight - window.innerHeight);
  if (maxScrollTop <= 0) {
    return 0;
  }
  return clampChapterProgress(window.scrollY / maxScrollTop);
}

function calculateScrollTopFromProgress(progress: number): number {
  const normalized = clampChapterProgress(progress);
  const documentElement = document.documentElement;
  const maxScrollTop = Math.max(0, documentElement.scrollHeight - window.innerHeight);
  return maxScrollTop * normalized;
}

function clampParagraphIndex(index: number, paragraphCount: number): number {
  if (paragraphCount <= 0) {
    return 0;
  }
  if (index < 0) {
    return 0;
  }
  if (index >= paragraphCount) {
    return paragraphCount - 1;
  }
  return index;
}

function buildParagraphProcessingOrder(paragraphCount: number, anchorIndex: number): number[] {
  if (paragraphCount <= 0) {
    return [];
  }

  const order: number[] = [];
  const safeAnchor = clampParagraphIndex(anchorIndex, paragraphCount);
  order.push(safeAnchor);

  for (let step = 1; order.length < paragraphCount; step += 1) {
    const up = safeAnchor - step;
    if (up >= 0) {
      order.push(up);
    }
    const down = safeAnchor + step;
    if (down < paragraphCount) {
      order.push(down);
    }
  }

  return order;
}

function buildParagraphAnalysisAtIndex(
  selectedBook: ImportedBook,
  paragraphIndex: number,
  analyze: ChapterAnalyzer,
): ParagraphAnalysis {
  const chapterNumber = clampChapterNumber(selectedBook, selectedBook.currentChapter);
  const chapterIndex = chapterNumber - 1;
  const chapter = selectedBook.chapters[chapterIndex];
  if (!chapter) {
    return { paragraphText: '', tokens: [], cardTargets: [] };
  }
  const paragraphText = chapter.paragraphs[paragraphIndex] ?? '';
  const analyses = analyze({
    title: chapter.title,
    paragraphs: [paragraphText],
  });

  return analyses[0] ?? { paragraphText, tokens: [], cardTargets: [] };
}

function areParagraphAnalysesVisuallyEquivalent(left: ParagraphAnalysis, right: ParagraphAnalysis): boolean {
  if (left.paragraphText !== right.paragraphText) {
    return false;
  }
  if (left.cardTargets.length !== right.cardTargets.length) {
    return false;
  }
  for (let index = 0; index < left.cardTargets.length; index += 1) {
    if (!areDefinitionTargetsEqual(left.cardTargets[index], right.cardTargets[index])) {
      return false;
    }
  }
  if (left.tokens.length !== right.tokens.length) {
    return false;
  }
  for (let index = 0; index < left.tokens.length; index += 1) {
    const leftToken = left.tokens[index];
    const rightToken = right.tokens[index];
    if (
      leftToken.start !== rightToken.start
      || leftToken.end !== rightToken.end
      || leftToken.lemma !== rightToken.lemma
      || leftToken.unknown !== rightToken.unknown
      || leftToken.proper !== rightToken.proper
      || leftToken.partOfSpeech !== rightToken.partOfSpeech
    ) {
      return false;
    }
  }
  return true;
}

function buildPlainChapterAnalysis(selectedBook: ImportedBook): ParagraphAnalysis[] {
  const chapterNumber = clampChapterNumber(selectedBook, selectedBook.currentChapter);
  const chapterIndex = chapterNumber - 1;
  const chapter = selectedBook.chapters[chapterIndex];
  if (!chapter) {
    return [];
  }
  return chapter.paragraphs.map((paragraphText) => ({ paragraphText, tokens: [], cardTargets: [] }));
}

function resolveKnowledgeThreshold(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  if (value < 0.05) {
    return 0.05;
  }
  if (value > 0.95) {
    return 0.95;
  }
  return value;
}

function resolveDeduplicationRadius(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const integer = Math.trunc(value);
  if (integer < 0) {
    return 0;
  }
  if (integer > 20) {
    return 20;
  }
  return integer;
}

function selectDeduplicatedCardTargets(
  tokens: ParagraphAnalysis['tokens'],
  maxCardsPerParagraph: number,
  threshold: number,
  suppressedTargetKeys: Set<string>,
): DefinitionTarget[] {
  if (maxCardsPerParagraph <= 0) {
    return [];
  }

  const ranked = rankParagraphCardTargets(tokens, threshold);
  const selected: DefinitionTarget[] = [];
  for (const target of ranked) {
    if (selected.length >= maxCardsPerParagraph) {
      break;
    }
    if (suppressedTargetKeys.has(definitionTargetKey(target))) {
      continue;
    }
    selected.push(target);
  }
  return selected;
}

function deduplicateParagraphCardTargets(
  analysis: ParagraphAnalysis,
  paragraphIndex: number,
  previousAnalyses: ReadonlyMap<number, ParagraphAnalysis>,
  settings: ReaderSettings,
): DefinitionTarget[] {
  const radius = resolveDeduplicationRadius(settings.deduplicationRadius);
  const suppressedTargetKeys = new Set<string>();
  for (const [seenIndex, nearbyAnalysis] of previousAnalyses) {
    if (radius === 0 || Math.abs(seenIndex - paragraphIndex) > radius) continue;
    for (const target of nearbyAnalysis.cardTargets) suppressedTargetKeys.add(definitionTargetKey(target));
  }
  return selectDeduplicatedCardTargets(
    analysis.tokens,
    Math.max(1, Math.min(5, settings.maxWordsPerParagraph)),
    resolveKnowledgeThreshold(settings.knowledgeThreshold),
    suppressedTargetKeys,
  );
}

function readerTargetDomKey(target: DefinitionTarget, sourceParagraphIndex: number): string {
  return `${sourceParagraphIndex}:${encodeURIComponent(definitionTargetKey(target))}`;
}

function readerPaginationLayoutKey(
  book: ImportedBook,
  profileId: string | null,
  profileKey: string,
  chapterIndex: number,
  viewportWidth: number,
  viewportHeight: number,
  pageHeight: number,
  settings: ReaderSettings,
  assistanceEnabled: boolean,
): string {
  return JSON.stringify([
    book.id,
    book.updatedAt,
    profileId,
    profileKey,
    chapterIndex,
    viewportWidth,
    viewportHeight,
    pageHeight,
    settings,
    assistanceEnabled,
  ]);
}

function abortReaderPrerenderControllers(controllers: Map<number, AbortController>): void {
  controllers.forEach((controller) => controller.abort());
  controllers.clear();
}

export default function ReaderPage() {
  const { bookId } = useParams();
  const [, setLocation] = useLocation();
  const { settings, updateSetting } = useSettings();
  const fullscreenPageMode = settings.readingMode === 'page' && settings.fullscreenPageMode;
  const { theme, setTheme } = useTheme();

  const [book, setBook] = useState<ImportedBook | null>(null);
  const [assistanceEnabled, setAssistanceEnabled] = useState(true);
  const [headerVisible, setHeaderVisible] = useState(true);
  const [readerSettingsOpen, setReaderSettingsOpen] = useState(false);
  const [fullscreenToolbarOpen, setFullscreenToolbarOpen] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [navigationSearchRequested, setNavigationSearchRequested] = useState(false);
  const [bookmarks, setBookmarks] = useState<ReaderBookmark[]>([]);
  const [bookmarkFeedback, setBookmarkFeedback] = useState('');
  const [currentLocation, setCurrentLocation] = useState<ReaderLocation>({ chapterIndex: 0, blockIndex: 0, textOffset: 0 });
  const [readingProgressPercent, setReadingProgressPercent] = useState(0);
  const [returnLocation, setReturnLocation] = useState<ReaderLocation | null>(null);
  const [chapterAnalysis, setChapterAnalysis] = useState<ParagraphAnalysis[]>([]);
  const [definitionsByLemma, setDefinitionsByLemma] = useState<Map<string, LexiconEntry>>(new Map());
  const [loadingDefinitionLemmas, setLoadingDefinitionLemmas] = useState<Set<string>>(new Set());
  const [failedDefinitionLemmas, setFailedDefinitionLemmas] = useState<Set<string>>(new Set());
  const [wordPopups, setWordPopups] = useState<WordPopupState[]>([]);
  const [activeAnalysisRunId, setActiveAnalysisRunId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [initialViewportReady, setInitialViewportReady] = useState(false);
  const [initialLoadingMessage, setInitialLoadingMessage] = useState<string>('Loading reader...');
  const [initialProgressRestored, setInitialProgressRestored] = useState(false);
  const [initialAnalysisRevision, setInitialAnalysisRevision] = useState(0);
  const [studyOpen, setStudyOpen] = useState(false);
  const [studyScope, setStudyScope] = useState<StudyTextScope | null>(null);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [pageAnalysisCompleteRunId, setPageAnalysisCompleteRunId] = useState<number | null>(null);
  const [pageAnalysisError, setPageAnalysisError] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const paginationLayoutRef = useRef<ReaderPaginationLayout | null>(null);
  const paginationLayoutKeyRef = useRef('');
  const paginationSettledMeasurementRevisionRef = useRef(0);
  const resourcesRef = useRef<ReaderResources | null>(null);
  const bookRef = useRef<ImportedBook | null>(null);
  const readerProfileIdRef = useRef<string | null>(null);
  const readerLoadRunIdRef = useRef(0);
  const chapterAnalysisRef = useRef<ParagraphAnalysis[]>([]);
  const definitionsByLemmaRef = useRef<Map<string, LexiconEntry>>(new Map());
  const automaticDefinitionRequestsRef = useRef<Map<string, Promise<void>>>(new Map());
  const nextWordPopupIdRef = useRef(1);
  const settingsRef = useRef<ReaderSettings>(settings);
  const assistanceEnabledRef = useRef<boolean>(assistanceEnabled);
  const analysisRunIdRef = useRef(0);
  const deferredAnalysisHandleRef = useRef<DeferredHandle | null>(null);
  const progressPersistTimeoutRef = useRef<number | null>(null);
  const bookmarkFeedbackTimeoutRef = useRef<number | null>(null);
  const layoutRestoreTimeoutRef = useRef<number | null>(null);
  const delayedRestoreTimeoutRef = useRef<number | null>(null);
  const isRestoringProgressRef = useRef(false);
  const readerRootRef = useRef<HTMLDivElement | null>(null);
  const pageViewportRef = useRef<HTMLElement | null>(null);
  const pageSwipeStartRef = useRef<PageSwipeStart | null>(null);
  const suppressPageSwipeClickUntilRef = useRef(0);
  const currentPageIndexRef = useRef(0);
  const pageAnchorLocationRef = useRef<ReaderLocation | null>(null);
  const pendingPageAnchorRef = useRef<ReaderLocation | null>(null);
  const pageRefreshAnchorRef = useRef<PageRefreshAnchor | null>(null);
  const paginationInertStateRef = useRef(new WeakMap<HTMLElement, { inert: boolean; ariaHidden: string | null }>());
  const persistCurrentChapterProgressRef = useRef<(force: boolean) => void>(() => {});
  const currentLocationRef = useRef<ReaderLocation | null>(null);
  const lastStableLocationRef = useRef<ReaderLocation | null>(null);
  const isBookFinishedRef = useRef(false);
  const canonicalAnchorCapturedRef = useRef(false);
  const previousLayoutKeyRef = useRef(JSON.stringify([
    settings.fontChoice,
    settings.fontSize,
    settings.lineSpacing,
    settings.pageWidth,
    assistanceEnabled,
  ]));
  const returnLocationRef = useRef<ReaderLocation | null>(null);
  const navigationHistoryRef = useRef<ReaderLocation[]>([]);
  const pendingReaderAnchorRef = useRef<string | null>(null);
  const initialReaderLoadPendingRef = useRef(false);
  const initialViewportParagraphsRef = useRef<number[] | null>(null);
  const completedInitialAnalysisRef = useRef<Set<number>>(new Set());
  const publishedAnalysisParagraphsRef = useRef<Set<number>>(new Set());
  const initialAnalysisFailedRef = useRef(false);
  const readyInitialCardsRef = useRef<Set<string>>(new Set());
  const preparedChapterOpeningsRef = useRef<Map<number, PreparedChapterOpening>>(new Map());
  const activePreparedOpeningRef = useRef<PreparedChapterOpening | null>(null);
  const instantChapterTransitionRef = useRef<PreparedChapterOpening | null>(null);
  const pageModeWasRevealedRef = useRef(false);
  const previousReadingModeRef = useRef(settings.readingMode);
  const chapterPrerenderControllersRef = useRef<Map<number, AbortController>>(new Map());
  const [, setNextChapterPreloadRevision] = useState(0);

  useEffect(() => {
    const updateViewportSize = (): void => {
      setViewportSize({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', updateViewportSize);
    return () => window.removeEventListener('resize', updateViewportSize);
  }, []);

  const paginationChapterIndex = book ? clampChapterNumber(book, book.currentChapter) - 1 : 0;
  const fullscreenTopSpacing = Math.ceil(settings.fontSize * (settings.lineSpacing === 'Compact'
    ? 1.375
    : settings.lineSpacing === 'Relaxed' ? 2 : 1.625));
  const paginationPageHeight = Math.max(1, viewportSize.height - (fullscreenPageMode ? fullscreenTopSpacing + 36 : 136));
  const paginationProfileKey = JSON.stringify(getActiveProfile(loadProfileState()));
  const paginationAnchor = useMemo(() => book
    ? book.location ?? readerLocationFromLegacyProgress(book, book.currentChapter, book.currentChapterProgress)
    : null, [book]);
  const pageCardsSettled = !assistanceEnabled || chapterAnalysis.every((analysis, paragraphIndex) =>
    analysis.cardTargets.every((target) => {
      const key = `${paragraphIndex}:${definitionTargetKey(target)}`;
      const lemma = normalizeToken(target.lemma);
      return readyInitialCardsRef.current.has(key)
        && (definitionsByLemma.has(lemma) || failedDefinitionLemmas.has(lemma));
    }));
  const paginationSettled = Boolean(book)
    && pageAnalysisCompleteRunId === analysisRunIdRef.current
    && pageAnalysisError === null
    && pageCardsSettled;
  const paginationLayoutKey = book
    ? readerPaginationLayoutKey(
      book,
      readerProfileIdRef.current,
      paginationProfileKey,
      paginationChapterIndex,
      viewportSize.width,
      viewportSize.height,
      paginationPageHeight,
      settings,
      assistanceEnabled,
    )
    : '';
  const getOpeningPageMeasurementKey = useCallback((layout: ReaderPaginationLayout | null): string | null => {
    if (settings.readingMode !== 'page' || !layout
      || layout.layoutKey !== paginationLayoutKey
      || layout.chapterIndex !== paginationChapterIndex) return null;
    const page = layout.pages[currentPageIndex] ?? layout.pages[0];
    const chapter = book?.chapters[paginationChapterIndex];
    if (!page || !chapter) return null;
    const blocks = readerBlocksForChapter(chapter.paragraphs, chapter.readerBlocks);
    const paragraphIndices = [...new Set(page.blockFragments.flatMap((fragment) => {
      const block = blocks[fragment.blockIndex];
      return block?.type === 'paragraph' ? [block.paragraphIndex] : [];
    }))];
    const pageTargets = new Set(page.cardTargetKeys);
    const analyses = paragraphIndices.map((index) => {
      const analysis = chapterAnalysis[index];
      const analysisReady = pageAnalysisCompleteRunId === analysisRunIdRef.current
        || publishedAnalysisParagraphsRef.current.has(index)
        || initialAnalysisFailedRef.current;
      if (!analysis || (assistanceEnabled && !analysisReady)) return null;
      const targets = analysis.cardTargets.map((target) => {
        const targetKey = definitionTargetKey(target);
        const onPage = pageTargets.has(readerTargetDomKey(target, index));
        const lemma = normalizeToken(target.lemma);
        const ready = !assistanceEnabled || !onPage || (
          !loadingDefinitionLemmas.has(lemma)
          && (definitionsByLemma.has(lemma) || failedDefinitionLemmas.has(lemma))
          && readyInitialCardsRef.current.has(`${index}:${targetKey}`)
        );
        return [targetKey, onPage, ready];
      });
      if (targets.some((target) => target[2] === false)) return null;
      return [index, targets];
    });
    if (analyses.some((analysis) => analysis === null)) return null;
    return JSON.stringify([
      layout.layoutKey,
      layout.chapterIndex,
      page.startLocation,
      page.endLocation,
      page.blockFragments.map((fragment) => [fragment.blockIndex, fragment.startY, fragment.endY, fragment.startOffset, fragment.endOffset]),
      page.cardTargetKeys,
      page.cardGroups,
      page.reservedCardHeight,
      page.presentationHeight,
      page.blockDisplayOffsets,
      analyses,
    ]);
  }, [
    settings.readingMode,
    paginationLayoutKey,
    paginationChapterIndex,
    currentPageIndex,
    book,
    assistanceEnabled,
    chapterAnalysis,
    pageAnalysisCompleteRunId,
    loadingDefinitionLemmas,
    definitionsByLemma,
    failedDefinitionLemmas,
    initialAnalysisRevision,
  ]);
  const preparedActiveChapter = preparedChapterOpeningsRef.current.get(paginationChapterIndex);
  const preRenderedActiveLayout = preparedActiveChapter !== undefined
    && preparedActiveChapter.bookId === book?.id
    && preparedActiveChapter.bookUpdatedAt === book?.updatedAt
    && preparedActiveChapter.layoutKey === paginationLayoutKey
    && preparedActiveChapter.analysisComplete
    && preparedActiveChapter.previewError === null
    ? preparedActiveChapter.layout
    : null;
  const pagination = useReaderPagination({
    rootRef: readerRootRef,
    initialLayout: preRenderedActiveLayout,
    enabled: settings.readingMode === 'page' && book !== null && !isLoading,
    settled: paginationSettled,
    getMeasurementKey: getOpeningPageMeasurementKey,
    layoutKey: paginationLayoutKey,
    chapterIndex: paginationChapterIndex,
    pageHeight: paginationPageHeight,
    anchor: paginationAnchor,
  });
  const paginationErrorMessage = pageAnalysisError ?? pagination.error?.message ?? null;
  const currentPaginationLayout = pagination.layout?.layoutKey === paginationLayoutKey
    && pagination.layout.chapterIndex === paginationChapterIndex
    ? pagination.layout
    : null;
  const displayedPage = currentPaginationLayout?.pages[currentPageIndex]
    ?? currentPaginationLayout?.pages[0]
    ?? null;
  const displayedChapter = book?.chapters[paginationChapterIndex];
  const displayedChapterBlocks = useMemo(() => displayedChapter
    ? readerBlocksForChapter(displayedChapter.paragraphs, displayedChapter.readerBlocks)
    : [], [displayedChapter]);
  const displayedPageParagraphs = useMemo(() => displayedPage
    ? [...new Set(displayedPage.blockFragments.flatMap((fragment) => {
      const block = displayedChapterBlocks[fragment.blockIndex];
      return block?.type === 'paragraph' ? [block.paragraphIndex] : [];
    }))]
    : [], [displayedPage, displayedChapterBlocks]);
  const openingPageMeasurementKey = getOpeningPageMeasurementKey(currentPaginationLayout);
  const pageModeReady = settings.readingMode === 'page'
    && pagination.isReady
    && initialViewportReady
    && (pageModeWasRevealedRef.current
      || (openingPageMeasurementKey !== null
        && pagination.measuredMeasurementKey === openingPageMeasurementKey))
    && paginationErrorMessage === null;

  useLayoutEffect(() => {
    const chapter = book?.chapters[paginationChapterIndex];
    if (!pageModeReady || !book || !chapter || !currentPaginationLayout) return;
    if (currentPaginationLayout.layoutKey !== paginationLayoutKey
      || currentPaginationLayout.chapterIndex !== paginationChapterIndex) return;
    const chapterIndex = paginationChapterIndex;
    const existing = preparedChapterOpeningsRef.current.get(chapterIndex);
    const compatibleExisting = existing?.layoutKey === paginationLayoutKey ? existing : undefined;
    const scores = compatibleExisting?.scores ?? activePreparedOpeningRef.current?.scores ?? new Map<string, ScoredDefinition>();
    const prepared: PreparedChapterOpening = {
      bookId: book.id,
      bookUpdatedAt: book.updatedAt,
      chapterIndex,
      chapter,
      layoutKey: paginationLayoutKey,
      settingsKey: JSON.stringify(settings),
      profileKey: paginationProfileKey,
      analyses: compatibleExisting?.analysisComplete ? compatibleExisting.analyses
        : new Map(chapterAnalysis.map((analysis, index) => [index, analysis])),
      scores,
      readyCards: new Set([...compatibleExisting?.readyCards ?? [], ...readyInitialCardsRef.current]),
      analysisComplete: paginationSettled || compatibleExisting?.analysisComplete === true,
      cardPreloadComplete: pageCardsSettled || compatibleExisting?.cardPreloadComplete === true,
      viewportWidth: viewportSize.width,
      viewportHeight: viewportSize.height,
      layout: currentPaginationLayout,
      previewError: null,
    };
    if (compatibleExisting !== undefined
      && compatibleExisting.layoutKey === prepared.layoutKey
      && compatibleExisting.layout?.signature === prepared.layout?.signature
      && compatibleExisting.analysisComplete === prepared.analysisComplete
      && compatibleExisting.cardPreloadComplete === prepared.cardPreloadComplete
      && compatibleExisting.analyses.size === prepared.analyses.size
      && compatibleExisting.previewError === null) return;
    preparedChapterOpeningsRef.current.set(chapterIndex, prepared);
    activePreparedOpeningRef.current = prepared;
    setNextChapterPreloadRevision((revision) => revision + 1);
  }, [
    book,
    chapterAnalysis,
    book?.chapters,
    currentPaginationLayout,
    pageCardsSettled,
    pageModeReady,
    paginationChapterIndex,
    paginationLayoutKey,
    paginationProfileKey,
    paginationSettled,
    settings,
    viewportSize.height,
    viewportSize.width,
  ]);

  useLayoutEffect(() => {
    if (pageModeReady) pageModeWasRevealedRef.current = true;
  }, [pageModeReady]);

  useLayoutEffect(() => {
    paginationLayoutRef.current = pagination.layout;
    paginationLayoutKeyRef.current = paginationLayoutKey;
    paginationSettledMeasurementRevisionRef.current = pagination.settledMeasurementRevision;
  }, [pagination.layout, pagination.settledMeasurementRevision, paginationLayoutKey]);

  const beginReaderLoading = useCallback((initialPageIndex: number): void => {
    pageRefreshAnchorRef.current = null;
    analysisRunIdRef.current += 1;
    clearDeferredHandle(deferredAnalysisHandleRef.current);
    deferredAnalysisHandleRef.current = null;
    if (delayedRestoreTimeoutRef.current !== null) {
      window.clearTimeout(delayedRestoreTimeoutRef.current);
      delayedRestoreTimeoutRef.current = null;
    }
    initialReaderLoadPendingRef.current = true;
    pageModeWasRevealedRef.current = false;
    initialViewportParagraphsRef.current = null;
    completedInitialAnalysisRef.current = new Set();
    publishedAnalysisParagraphsRef.current = new Set();
    initialAnalysisFailedRef.current = false;
    readyInitialCardsRef.current = new Set();
    setPageAnalysisCompleteRunId(null);
    setPageAnalysisError(null);
    currentPageIndexRef.current = initialPageIndex;
    setCurrentPageIndex(initialPageIndex);
    setInitialViewportReady(false);
    setInitialLoadingMessage('Loading reader...');
    setInitialProgressRestored(false);
  }, []);

  const openReaderChapter = useCallback((nextBook: ImportedBook, entryDirection: ReaderChapterEntryDirection): void => {
    const currentBook = bookRef.current;
    const currentLayout = paginationLayoutRef.current;
    const currentChapterIndex = currentBook ? clampChapterNumber(currentBook, currentBook.currentChapter) - 1 : -1;
    const capturedLayoutKey = paginationLayoutKeyRef.current;
    const currentPreparedCandidates = [
      preparedChapterOpeningsRef.current.get(currentChapterIndex),
      activePreparedOpeningRef.current,
    ];
    const currentPrepared = currentPreparedCandidates.find((candidate): candidate is PreparedChapterOpening => candidate !== undefined
      && candidate !== null
      && currentBook !== null
      && candidate.bookId === currentBook.id
      && candidate.bookUpdatedAt === currentBook.updatedAt
      && candidate.chapterIndex === currentChapterIndex
      && candidate.layoutKey === capturedLayoutKey);
    if (settingsRef.current.readingMode === 'page'
      && currentBook
      && currentLayout
      && currentLayout.layoutKey === capturedLayoutKey
      && currentLayout.chapterIndex === currentChapterIndex
      && currentPrepared
      && currentPrepared.previewError === null
      && currentPrepared.layout?.signature !== currentLayout.signature) {
      currentPrepared.layout = currentLayout;
      preparedChapterOpeningsRef.current.set(currentChapterIndex, currentPrepared);
    }

    const chapterIndex = clampChapterNumber(nextBook, nextBook.currentChapter) - 1;
    const prepared = preparedChapterOpeningsRef.current.get(chapterIndex) ?? null;
    const profile = getActiveProfile(loadProfileState());
    const chapter = nextBook.chapters[chapterIndex];
    const currentPageHeight = Math.max(1, window.innerHeight - (fullscreenPageMode
      ? Math.ceil(settingsRef.current.fontSize * (settingsRef.current.lineSpacing === 'Compact'
        ? 1.375
        : settingsRef.current.lineSpacing === 'Relaxed' ? 2 : 1.625)) + 36
      : 136));
    const currentLayoutKey = chapter
      ? readerPaginationLayoutKey(
        nextBook,
        readerProfileIdRef.current,
        JSON.stringify(profile),
        chapterIndex,
        window.innerWidth,
        window.innerHeight,
        currentPageHeight,
        settingsRef.current,
        assistanceEnabledRef.current,
      )
      : '';
    const compatiblePrepared = prepared?.bookId === nextBook.id
      && prepared.bookUpdatedAt === nextBook.updatedAt
      && prepared.chapter === chapter
      && prepared.chapterIndex === chapterIndex
      && prepared.layoutKey === currentLayoutKey
      && prepared.settingsKey === JSON.stringify(settingsRef.current)
      && prepared.profileKey === JSON.stringify(profile)
      && prepared.viewportWidth === window.innerWidth
      && prepared.viewportHeight === window.innerHeight
      && prepared.analysisComplete
      ? prepared
      : null;
    const hasPageLayout = settingsRef.current.readingMode === 'page'
      && Boolean(compatiblePrepared?.layout)
      && compatiblePrepared?.previewError === null;
    const initialPageIndex = hasPageLayout && compatiblePrepared?.layout
      ? entryDirection === 'first' ? 0
        : entryDirection === 'last' ? Math.max(0, compatiblePrepared.layout.pages.length - 1)
          : readerPageIndexForLocation(compatiblePrepared.layout.pages, nextBook.location
            ?? readerLocationFromLegacyProgress(nextBook, nextBook.currentChapter, nextBook.currentChapterProgress)) ?? 0
      : 0;
    const readyOpening = compatiblePrepared
      ?? (prepared?.bookId === nextBook.id && prepared.chapter === chapter
        && prepared.settingsKey === JSON.stringify(settingsRef.current)
        && prepared.profileKey === JSON.stringify(profile)
        && (prepared.analysisComplete || prepared.analyses.size > 0)
        && settingsRef.current.readingMode === 'scroll'
        && nextBook.currentChapterProgress === 0
        ? prepared : null);
    bookRef.current = nextBook;
    beginReaderLoading(initialPageIndex);
    if (hasPageLayout) pageModeWasRevealedRef.current = true;
    const analyses = buildPlainChapterAnalysis(nextBook);
    activePreparedOpeningRef.current = readyOpening;
    instantChapterTransitionRef.current = settingsRef.current.readingMode === 'scroll' ? readyOpening : null;
    if (readyOpening) {
      for (const [index, analysis] of readyOpening.analyses) analyses[index] = analysis;
    }
    if (readyOpening && (settingsRef.current.readingMode === 'scroll' || hasPageLayout)) {
      setDefinitionsByLemma(new Map(definitionsByLemmaRef.current));
      initialReaderLoadPendingRef.current = false;
      setInitialViewportReady(true);
      setInitialProgressRestored(true);
      if (settingsRef.current.readingMode === 'page' && readyOpening.analysisComplete) {
        const preparedIndexes = new Set(readyOpening.analyses.keys());
        publishedAnalysisParagraphsRef.current = preparedIndexes;
        completedInitialAnalysisRef.current = preparedIndexes;
        readyInitialCardsRef.current = new Set(readyOpening.readyCards);
        setPageAnalysisCompleteRunId(analysisRunIdRef.current);
        setInitialAnalysisRevision((revision) => revision + 1);
      }
    }
    setChapterAnalysis(analyses);
    if (nextBook.currentChapterProgress === 0) setHeaderVisible(true);
    setBook(nextBook);
  }, [beginReaderLoading, fullscreenPageMode]);

  const recordInitialCardReadiness = useCallback((paragraphIndex: number, targetKey: string, ready: boolean): void => {
    const key = `${paragraphIndex}:${targetKey}`;
    if (readyInitialCardsRef.current.has(key) === ready) return;
    if (ready) {
      readyInitialCardsRef.current.add(key);
    } else {
      readyInitialCardsRef.current.delete(key);
    }
    setInitialAnalysisRevision((revision) => revision + 1);
  }, []);

  const lastScrollY = useRef(0);
  const scrollDirectionRef = useRef<-1 | 0 | 1>(0);
  const lastScrollActivityAtRef = useRef(Number.NEGATIVE_INFINITY);

  const paraRefs = useRef<(HTMLElement | null)[]>([]);
  const wordPopupRefs = useRef<(HTMLDivElement | null)[]>([]);

  const setParagraphElement = useCallback((visibleParagraphIndex: number, element: HTMLElement | null) => {
    paraRefs.current[visibleParagraphIndex] = element;
  }, []);
  const getParagraphElement = useCallback((visibleParagraphIndex: number): HTMLElement | null => (
    settings.readingMode === 'page'
      ? pageViewportRef.current
      : paraRefs.current[visibleParagraphIndex] ?? null
  ), [settings.readingMode]);

  const resolveAnalysisAnchorIndex = useCallback((paragraphCount: number, chapterProgress: number) => {
    if (paragraphCount <= 0) {
      return 0;
    }

    const fallbackIndex = clampParagraphIndex(
      Math.floor(clampChapterProgress(chapterProgress) * Math.max(0, paragraphCount - 1)),
      paragraphCount,
    );
    const visibleParagraphs = paraRefs.current.slice(0, paragraphCount);
    const targetY = Math.min(window.innerHeight - 1, Math.max(80, Math.floor(window.innerHeight * 0.35)));

    let containingIndex = -1;
    for (let index = 0; index < visibleParagraphs.length; index += 1) {
      const element = visibleParagraphs[index];
      if (!element) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (rect.top <= targetY && rect.bottom >= targetY) {
        containingIndex = index;
        break;
      }
    }
    if (containingIndex >= 0) {
      return containingIndex;
    }

    let closestIndex = -1;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < visibleParagraphs.length; index += 1) {
      const element = visibleParagraphs[index];
      if (!element) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      const distance = Math.abs(rect.top - targetY);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    }
    if (closestIndex >= 0) {
      return closestIndex;
    }

    return fallbackIndex;
  }, []);

  const pendingAnalysisAnchorIndexRef = useRef<number | null>(null);

  const waitForReaderScrollToSettle = useCallback(async (): Promise<void> => {
    let remainingMs = ANALYSIS_SCROLL_SETTLE_MS - (performance.now() - lastScrollActivityAtRef.current);
    while (remainingMs > 0) {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, Math.min(ANALYSIS_SCROLL_POLL_MS, remainingMs));
      });
      remainingMs = ANALYSIS_SCROLL_SETTLE_MS - (performance.now() - lastScrollActivityAtRef.current);
    }
  }, []);

  const requestAutomaticDefinition = useCallback((resources: ReaderResources, target: DefinitionTarget) => {
    const lemma = normalizeToken(target.lemma);
    if (
      lemma.length === 0
      || definitionsByLemmaRef.current.has(lemma)
      || automaticDefinitionRequestsRef.current.has(lemma)
    ) {
      return;
    }
    setLoadingDefinitionLemmas((previous) => {
      const updated = new Set(previous);
      updated.add(lemma);
      return updated;
    });
    setFailedDefinitionLemmas((previous) => {
      if (!previous.has(lemma)) {
        return previous;
      }
      const updated = new Set(previous);
      updated.delete(lemma);
      return updated;
    });

    const request = lookupFirstAvailableDefinition(resources.lexicon, [{
      lookupWord: lemma,
      selectionEnd: lemma.length,
      selectionStart: 0,
      target,
    }])
      .then(async ({ entry }) => {
        await waitForReaderScrollToSettle();
        const resolvedEntry = entry ?? createFallbackLexiconEntry(lemma);
        definitionsByLemmaRef.current = new Map(definitionsByLemmaRef.current).set(lemma, resolvedEntry);
        setDefinitionsByLemma((previous) => new Map(previous).set(lemma, resolvedEntry));
      })
      .catch(async (error: unknown) => {
        await waitForReaderScrollToSettle();
        console.error('automatic-definition-load-failed', { lemma, error });
        setFailedDefinitionLemmas((previous) => new Set(previous).add(lemma));
      })
      .finally(() => {
        automaticDefinitionRequestsRef.current.delete(lemma);
        setLoadingDefinitionLemmas((previous) => {
          if (!previous.has(lemma)) {
            return previous;
          }
          const updated = new Set(previous);
          updated.delete(lemma);
          return updated;
        });
      });
    automaticDefinitionRequestsRef.current.set(lemma, request);
  }, [waitForReaderScrollToSettle]);

  const recomputeVisibleAnalysis = useCallback((
    selectedBook: ImportedBook,
    resources: ReaderResources,
    mode: AnalysisRefreshMode,
    anchorParagraphIndex?: number,
  ) => {
    const profileState = loadProfileState();
    const activeProfile = getActiveProfile(profileState);
    const currentPaginationLayout = paginationLayoutRef.current;
    if (mode === 'preserve' && !pageRefreshAnchorRef.current
      && currentPaginationLayout?.layoutKey === paginationLayoutKeyRef.current
      && currentPaginationLayout.chapterIndex === selectedBook.currentChapter - 1) {
      const currentPage = currentPaginationLayout.pages[currentPageIndexRef.current];
      const location = pendingPageAnchorRef.current
        ?? currentPage?.startLocation
        ?? pageAnchorLocationRef.current
        ?? currentLocationRef.current;
      if (location) {
        pageRefreshAnchorRef.current = {
          location,
          layout: currentPaginationLayout,
          settledMeasurementRevision: paginationSettledMeasurementRevisionRef.current,
        };
      }
    } else if (mode === 'reset') {
      pageRefreshAnchorRef.current = null;
    }
    const currentRunId = analysisRunIdRef.current + 1;
    analysisRunIdRef.current = currentRunId;
    setPageAnalysisCompleteRunId(null);
    setPageAnalysisError(null);
    const expectedParagraphCount = buildPlainChapterAnalysis(selectedBook).length;

    const plainAnalyses = buildPlainChapterAnalysis(selectedBook);
    const canPreserveExisting = (
      mode === 'preserve'
      && chapterAnalysisRef.current.length === expectedParagraphCount
      && chapterAnalysisRef.current.every((analysis, index) => analysis.paragraphText === (plainAnalyses[index]?.paragraphText ?? ''))
    );
    const chapter = selectedBook.chapters[clampChapterNumber(selectedBook, selectedBook.currentChapter) - 1];
    const prepared = activePreparedOpeningRef.current;
    const preparedAnalyses = prepared?.bookId === selectedBook.id
      && prepared.bookUpdatedAt === selectedBook.updatedAt
      && prepared.chapter === chapter
      && prepared.settingsKey === JSON.stringify(settingsRef.current)
      && prepared.profileKey === JSON.stringify(activeProfile)
      ? prepared.analyses : new Map<number, ParagraphAnalysis>();
    const hasCompletePreparedAnalysis = settingsRef.current.readingMode === 'page'
      && prepared?.analysisComplete === true
      && prepared.analyses === preparedAnalyses
      && preparedAnalyses.size === expectedParagraphCount
      && Array.from({ length: expectedParagraphCount }, (_, index) => preparedAnalyses.has(index)).every(Boolean);
    if (hasCompletePreparedAnalysis && prepared) {
      const completeAnalyses = Array.from({ length: expectedParagraphCount }, (_, index) => preparedAnalyses.get(index))
        .flatMap((analysis) => analysis ? [analysis] : []);
      chapterAnalysisRef.current = completeAnalyses;
      readyInitialCardsRef.current = new Set(prepared.readyCards);
      publishedAnalysisParagraphsRef.current = new Set(completeAnalyses.map((_, index) => index));
      completedInitialAnalysisRef.current = new Set(publishedAnalysisParagraphsRef.current);
      setChapterAnalysis(completeAnalyses);
      setPageAnalysisCompleteRunId(currentRunId);
      setPageAnalysisError(null);
      setInitialAnalysisRevision((revision) => revision + 1);
      clearDeferredHandle(deferredAnalysisHandleRef.current);
      deferredAnalysisHandleRef.current = null;
      return;
    }
    const initialAnalyses = canPreserveExisting ? chapterAnalysisRef.current.slice() : plainAnalyses;
    if (!canPreserveExisting) {
      for (const [index, analysis] of preparedAnalyses) initialAnalyses[index] = analysis;
      if (initialReaderLoadPendingRef.current) {
        for (const index of preparedAnalyses.keys()) publishedAnalysisParagraphsRef.current.add(index);
        for (const index of initialViewportParagraphsRef.current ?? []) {
          if (preparedAnalyses.has(index)) completedInitialAnalysisRef.current.add(index);
        }
        setInitialAnalysisRevision((revision) => revision + 1);
      }
    }
    if (mode === 'reset' || !canPreserveExisting) {
      setChapterAnalysis(initialAnalyses);
    }
    clearDeferredHandle(deferredAnalysisHandleRef.current);
    deferredAnalysisHandleRef.current = null;

    if (!assistanceEnabledRef.current) {
      setChapterAnalysis(plainAnalyses);
      setPageAnalysisCompleteRunId(currentRunId);
      setInitialAnalysisRevision((revision) => revision + 1);
      return;
    }

    deferredAnalysisHandleRef.current = scheduleDeferredTask(() => {
      if (analysisRunIdRef.current !== currentRunId) {
        return;
      }

      setActiveAnalysisRunId(currentRunId);
      void (async () => {
        try {
          await yieldForAnalysisContinuation();
          if (analysisRunIdRef.current !== currentRunId) {
            return;
          }
          const nextAnalyses = initialAnalyses.slice();
          const processedAnalyses = new Map(preparedAnalyses);
          const analyzeParagraph = createCachedChapterAnalyzer({
            settings: settingsRef.current,
            model: resources.model,
            profile: activeProfile,
            lemmaDict: resources.lemmaDict,
            nlp: resources.nlp,
            maxCardsPerParagraph: 1,
            includeCards: false,
          }, resources.lexicalAnalysisCache);
          const resolvedAnchorIndex = typeof anchorParagraphIndex === 'number' && Number.isFinite(anchorParagraphIndex)
            ? clampParagraphIndex(anchorParagraphIndex, expectedParagraphCount)
            : resolveAnalysisAnchorIndex(expectedParagraphCount, selectedBook.currentChapterProgress);
          const pageModeAnalysis = settingsRef.current.readingMode === 'page';
          const savedLocation = selectedBook.location
            ?? readerLocationFromLegacyProgress(selectedBook, selectedBook.currentChapter, selectedBook.currentChapterProgress);
          const selectedChapter = selectedBook.chapters[clampChapterNumber(selectedBook, selectedBook.currentChapter) - 1];
          const readerBlocks = selectedChapter
            ? readerBlocksForChapter(selectedChapter.paragraphs, selectedChapter.readerBlocks)
            : [];
          const locationBlockIndex = savedLocation.chapterIndex === selectedBook.currentChapter - 1
            ? Math.min(savedLocation.blockIndex, Math.max(0, readerBlocks.length - 1))
            : -1;
          const locationParagraphIndex = locationBlockIndex >= 0
            ? readerBlocks.slice(locationBlockIndex).find((block) => block.type === 'paragraph')?.paragraphIndex
              ?? [...readerBlocks.slice(0, locationBlockIndex)].reverse().find((block) => block.type === 'paragraph')?.paragraphIndex
            : undefined;
          const analysisAnchorIndex = anchorParagraphIndex !== undefined
            ? resolvedAnchorIndex
            : pageModeAnalysis && locationParagraphIndex !== undefined
              ? locationParagraphIndex
              : resolveAnalysisAnchorIndex(expectedParagraphCount, selectedBook.currentChapterProgress);
          const paragraphOrder = buildParagraphProcessingOrder(expectedParagraphCount, analysisAnchorIndex)
            .filter((index) => !preparedAnalyses.has(index));
          let pendingParagraphIndices: number[] = [];
          let timeSliceStartedAt = performance.now();
          let lastPublishedAt = timeSliceStartedAt;
          const waitForScrollToSettle = async (): Promise<boolean> => {
            let remainingMs = ANALYSIS_SCROLL_SETTLE_MS - (performance.now() - lastScrollActivityAtRef.current);
            while (remainingMs > 0) {
              await new Promise<void>((resolve) => {
                window.setTimeout(resolve, Math.min(ANALYSIS_SCROLL_POLL_MS, remainingMs));
              });
              if (analysisRunIdRef.current !== currentRunId) {
                return false;
              }
              remainingMs = ANALYSIS_SCROLL_SETTLE_MS - (performance.now() - lastScrollActivityAtRef.current);
            }
            return true;
          };

          for (let orderIndex = 0; orderIndex < paragraphOrder.length; orderIndex += 1) {
            if (!pageModeAnalysis && performance.now() - lastScrollActivityAtRef.current < ANALYSIS_SCROLL_SETTLE_MS) {
              if (!await waitForScrollToSettle()) {
                return;
              }
              timeSliceStartedAt = performance.now();
            }
            const paragraphIndex = paragraphOrder[orderIndex];
            if (analysisRunIdRef.current !== currentRunId) {
              return;
            }

            try {
              const analysis = buildParagraphAnalysisAtIndex(
                selectedBook,
                paragraphIndex,
                analyzeParagraph,
              );
              const deduplicatedCardTargets = deduplicateParagraphCardTargets(
                analysis, paragraphIndex, processedAnalyses, settingsRef.current,
              );
              const nextAnalysis: ParagraphAnalysis = {
                ...analysis,
                cardTargets: deduplicatedCardTargets,
              };
              nextAnalyses[paragraphIndex] = nextAnalysis;

              for (const target of nextAnalysis.cardTargets) {
                requestAutomaticDefinition(resources, target);
              }
              processedAnalyses.set(paragraphIndex, nextAnalysis);
            } catch (error) {
              console.warn('reader-paragraph-analysis-failed', {
                error,
                chapter: selectedBook.currentChapter,
                paragraphIndex,
                bookId: selectedBook.id,
              });
              const message = error instanceof Error ? error.message : String(error);
              setPageAnalysisError(`Paragraph analysis failed at paragraph ${paragraphIndex + 1}: ${message}`);
            }

            if (analysisRunIdRef.current !== currentRunId) {
              return;
            }
            if (!pageModeAnalysis && performance.now() - lastScrollActivityAtRef.current < ANALYSIS_SCROLL_SETTLE_MS) {
              if (!await waitForScrollToSettle()) {
                return;
              }
              timeSliceStartedAt = performance.now();
            }

            pendingParagraphIndices.push(paragraphIndex);
            const isLastParagraph = orderIndex === paragraphOrder.length - 1;
            const timeSliceElapsed = performance.now() - timeSliceStartedAt;
            const isFirstParagraph = orderIndex === 0;
            const shouldYield = isLastParagraph || timeSliceElapsed >= ANALYSIS_TIME_SLICE_MS;
            if (!shouldYield && !isFirstParagraph) {
              continue;
            }

            const now = performance.now();
            const shouldPublish = (
              isFirstParagraph
              || isLastParagraph
              || now - lastPublishedAt >= ANALYSIS_PUBLISH_INTERVAL_MS
            );
            if (shouldPublish) {
              const publishedParagraphIndices = pendingParagraphIndices;
              pendingParagraphIndices = [];
              setChapterAnalysis((previous) => {
                if (previous.length !== nextAnalyses.length) {
                  return nextAnalyses.slice();
                }
                let updated = previous;
                for (const publishedIndex of publishedParagraphIndices) {
                  const previousAnalysis = previous[publishedIndex];
                  const nextAnalysis = nextAnalyses[publishedIndex];
                  if (previousAnalysis && areParagraphAnalysesVisuallyEquivalent(previousAnalysis, nextAnalysis)) {
                    continue;
                  }
                  if (updated === previous) {
                    updated = previous.slice();
                  }
                  updated[publishedIndex] = nextAnalysis;
                }
                return updated;
              });
              if (initialReaderLoadPendingRef.current && analysisRunIdRef.current === currentRunId) {
                for (const publishedIndex of publishedParagraphIndices) {
                  publishedAnalysisParagraphsRef.current.add(publishedIndex);
                }
                const initialViewportParagraphs = initialViewportParagraphsRef.current;
                if (initialViewportParagraphs) {
                  for (const publishedIndex of publishedParagraphIndices) {
                    if (initialViewportParagraphs.includes(publishedIndex)) {
                      completedInitialAnalysisRef.current.add(publishedIndex);
                    }
                  }
                  setInitialAnalysisRevision((revision) => revision + 1);
                }
              }
              lastPublishedAt = now;
            }

            if (shouldYield || isFirstParagraph) {
              await yieldForAnalysisContinuation();
              timeSliceStartedAt = performance.now();
            }
          }
        } catch (error) {
          console.warn('reader-analysis-failed', { error, chapter: selectedBook.currentChapter, bookId: selectedBook.id });
          const message = error instanceof Error ? error.message : String(error);
          setPageAnalysisError(`Chapter analysis failed: ${message}`);
          if (initialReaderLoadPendingRef.current && analysisRunIdRef.current === currentRunId) {
            initialAnalysisFailedRef.current = true;
            for (const paragraphIndex of initialViewportParagraphsRef.current ?? []) {
              completedInitialAnalysisRef.current.add(paragraphIndex);
            }
            setInitialAnalysisRevision((revision) => revision + 1);
          }
        } finally {
          if (analysisRunIdRef.current === currentRunId) {
            setPageAnalysisCompleteRunId(currentRunId);
            setInitialAnalysisRevision((revision) => revision + 1);
          }
          setActiveAnalysisRunId((activeRunId) => activeRunId === currentRunId ? null : activeRunId);
        }
      })();
    }, 700);
  }, [requestAutomaticDefinition, resolveAnalysisAnchorIndex]);

  const captureCurrentReaderLocation = useCallback((): ReaderLocation | null => {
    const currentBook = bookRef.current;
    if (!currentBook) return null;
    if (settings.readingMode === 'page') {
      const currentPage = pagination.isReady
        && pagination.layout?.layoutKey === paginationLayoutKey
        ? pagination.layout.pages[currentPageIndexRef.current]
        : undefined;
      const location = currentPage?.startLocation
        ?? pageAnchorLocationRef.current
        ?? currentLocationRef.current;
      if (location) {
        currentLocationRef.current = location;
        lastStableLocationRef.current = location;
        canonicalAnchorCapturedRef.current = true;
      }
      return location;
    }
    const location = readerRootRef.current
      ? captureVisibleReaderLocation(readerRootRef.current, currentBook.currentChapter - 1, 72, window.innerHeight)
      : null;
    if (location) {
      const recentManualScroll = performance.now() - lastScrollActivityAtRef.current < 500;
      if (isBookFinishedRef.current && !recentManualScroll
        && !readerLocationsEqual(location, lastLinearReaderLocation(currentBook))) {
        return currentBook.location ?? currentLocationRef.current;
      }
      currentLocationRef.current = location;
      lastStableLocationRef.current = location;
      canonicalAnchorCapturedRef.current = true;
      return location;
    }
    return currentLocationRef.current;
  }, [pagination.isReady, pagination.layout, paginationLayoutKey, settings.readingMode]);

  const saveReaderBookProgress = useCallback((nextBook: ImportedBook): void => {
    const profileId = readerProfileIdRef.current;
    if (!profileId) throw new Error(`Cannot save reading progress without a loaded profile for book=${nextBook.id}.`);
    saveBookReadingProgress(profileId, nextBook.id, {
      currentChapter: nextBook.currentChapter,
      currentChapterProgress: nextBook.currentChapterProgress,
      ...(nextBook.location ? { location: nextBook.location } : {}),
      ...(nextBook.pagePosition ? { pagePosition: nextBook.pagePosition } : {}),
    });
  }, []);

  const commitReaderPage = useCallback((pageIndex: number, layout: ReaderPaginationLayout): void => {
    const currentBook = bookRef.current;
    const page = layout.pages[pageIndex];
    if (!currentBook || !page || page.startLocation.chapterIndex !== currentBook.currentChapter - 1) return;
    const pageStartLocation = resolveReaderLocation(currentBook, page.startLocation);
    const finishedLocation = lastLinearReaderLocation(currentBook);
    const finishedAtPageEnd = readerLocationsEqual(page.endLocation, finishedLocation);
    const location = finishedAtPageEnd ? finishedLocation : pageStartLocation;
    const chapter = currentBook.chapters[location.chapterIndex];
    const chapterProgress = chapter
      ? chapterProgressAtLocation(chapter, location.blockIndex, location.textOffset)
      : 0;
    const nextBook: ImportedBook = {
      ...currentBook,
      currentChapter: location.chapterIndex + 1,
      currentChapterProgress: chapterProgress,
      location,
      pagePosition: { layoutKey: layout.signature, pageIndex },
    };
    saveReaderBookProgress(nextBook);
    bookRef.current = nextBook;
    currentLocationRef.current = location;
    lastStableLocationRef.current = location;
    pageAnchorLocationRef.current = pageStartLocation;
    pendingPageAnchorRef.current = null;
    const pageRefreshAnchor = pageRefreshAnchorRef.current;
    if (pageRefreshAnchor?.layout === layout) {
      pageRefreshAnchorRef.current = { ...pageRefreshAnchor, location: pageStartLocation };
    }
    currentPageIndexRef.current = pageIndex;
    setCurrentPageIndex(pageIndex);
    if (pageViewportRef.current) pageViewportRef.current.scrollTop = 0;
    setCurrentLocation(location);
    setReadingProgressPercent(bookProgressAtLocation(currentBook, location) * 100);
    isBookFinishedRef.current = finishedAtPageEnd;
  }, [saveReaderBookProgress]);

  const persistCurrentChapterProgress = useCallback((force: boolean): void => {
    const currentBook = bookRef.current;
    if (!currentBook || isRestoringProgressRef.current || initialReaderLoadPendingRef.current) return;

    const location = isBookFinishedRef.current
      ? currentBook.location ?? currentLocationRef.current
      : captureCurrentReaderLocation() ?? currentBook.location ?? currentLocationRef.current;
    if (!location) return;
    const chapter = currentBook.chapters[location.chapterIndex];
    const chapterProgress = chapter
      ? chapterProgressAtLocation(chapter, location.blockIndex, location.textOffset)
      : 0;
    const wholeBookProgress = bookProgressAtLocation(currentBook, location);
    if (!force && currentBook.location?.chapterIndex === location.chapterIndex
      && currentBook.location.blockIndex === location.blockIndex
      && currentBook.location.textOffset === location.textOffset) return;
    const nextBook: ImportedBook = {
      ...currentBook,
      currentChapter: location.chapterIndex + 1,
      currentChapterProgress: chapterProgress,
      location,
      ...(settings.readingMode === 'page' && pagination.isReady && pagination.layout
        ? { pagePosition: { layoutKey: pagination.layout.signature, pageIndex: currentPageIndexRef.current } }
        : { pagePosition: undefined }),
    };
    saveReaderBookProgress(nextBook);
    bookRef.current = nextBook;
    currentLocationRef.current = location;
    setCurrentLocation(location);
    setReadingProgressPercent(wholeBookProgress * 100);
    isBookFinishedRef.current = readerLocationsEqual(location, lastLinearReaderLocation(currentBook));
  }, [captureCurrentReaderLocation, pagination.isReady, pagination.layout, saveReaderBookProgress, settings.readingMode]);

  persistCurrentChapterProgressRef.current = persistCurrentChapterProgress;
  useLayoutEffect(() => () => persistCurrentChapterProgressRef.current(true), []);

  const switchReadingMode = useCallback((readingMode: ReaderSettings['readingMode']): void => {
    if (settings.readingMode === readingMode) return;
    const currentBook = bookRef.current;
    const capturedLocation = settings.readingMode === 'page' && isBookFinishedRef.current && currentBook?.location
      ? currentBook.location
      : captureCurrentReaderLocation();
    if (currentBook && capturedLocation) {
      const location = resolveReaderLocation(currentBook, capturedLocation);
      const chapter = currentBook.chapters[location.chapterIndex];
      const chapterProgress = chapter
        ? chapterProgressAtLocation(chapter, location.blockIndex, location.textOffset)
        : 0;
      const nextBook: ImportedBook = {
        ...currentBook,
        currentChapter: location.chapterIndex + 1,
        currentChapterProgress: chapterProgress,
        location,
        pagePosition: readingMode === 'scroll' ? undefined : currentBook.pagePosition,
      };
      saveReaderBookProgress(nextBook);
      bookRef.current = nextBook;
      currentLocationRef.current = location;
      lastStableLocationRef.current = location;
      pageAnchorLocationRef.current = location;
      setCurrentLocation(location);
      setReadingProgressPercent(bookProgressAtLocation(currentBook, location) * 100);
      isBookFinishedRef.current = readerLocationsEqual(location, lastLinearReaderLocation(currentBook));
    }
    if (readingMode === 'page') {
      setPageAnalysisCompleteRunId(null);
      setPageAnalysisError(null);
      pageAnchorLocationRef.current = capturedLocation ?? currentLocationRef.current;
      setHeaderVisible(true);
    }
    if (readingMode === 'scroll') {
      setFullscreenToolbarOpen(false);
    }
    updateSetting('readingMode', readingMode);
    if (readingMode === 'scroll' && capturedLocation) {
      window.requestAnimationFrame(() => {
        if (readerRootRef.current) restoreReaderLocation(readerRootRef.current, capturedLocation, 72);
      });
    }
  }, [captureCurrentReaderLocation, saveReaderBookProgress, settings.readingMode, updateSetting]);

  const loadReaderState = useCallback(async () => {
    const profileId = getActiveProfile(loadProfileState()).id;
    const loadRunId = readerLoadRunIdRef.current + 1;
    readerLoadRunIdRef.current = loadRunId;
    readerProfileIdRef.current = profileId;
    bookRef.current = null;
    beginReaderLoading(0);
    abortReaderPrerenderControllers(chapterPrerenderControllersRef.current);
    preparedChapterOpeningsRef.current.clear();
    activePreparedOpeningRef.current = null;
    instantChapterTransitionRef.current = null;
    setIsLoading(true);
    setStudyOpen(false);
    setWordPopups([]);
    pendingReaderAnchorRef.current = null;

    try {
      const preferredBook = bookId ? await getBookById(bookId) : null;
      const storedBook = preferredBook ?? (await listBooks())[0] ?? null;
      if (readerLoadRunIdRef.current !== loadRunId) return;
      if (!storedBook) {
        setBook(null);
        setChapterAnalysis([]);
        setDefinitionsByLemma(new Map());
        setBookmarks([]);
        currentLocationRef.current = null;
        lastStableLocationRef.current = null;
        canonicalAnchorCapturedRef.current = false;
        isBookFinishedRef.current = false;
        resourcesRef.current = null;
        return;
      }
      const selectedBook = withBookReadingProgress(storedBook, profileId);
      const selectedLocation = selectedBook.location ?? readerLocationFromLegacyProgress(
        selectedBook,
        selectedBook.currentChapter,
        selectedBook.currentChapterProgress,
      );
      currentLocationRef.current = selectedLocation;
      lastStableLocationRef.current = selectedLocation;
      canonicalAnchorCapturedRef.current = Boolean(selectedBook.location);
      isBookFinishedRef.current = readerLocationsEqual(selectedLocation, lastLinearReaderLocation(selectedBook));
      setCurrentLocation(selectedLocation);
      setReadingProgressPercent(bookProgressAtLocation(selectedBook, selectedLocation) * 100);
      setBookmarks(listReaderBookmarks(profileId, selectedBook.id));

      const [model, lemmaDict, nlp] = await Promise.all([
        loadVocabularyModel(),
        loadLemmaDict(),
        loadCompromise(),
      ]);
      if (readerLoadRunIdRef.current !== loadRunId) return;

      const lexicalAnalysisCache = getSessionBookLexicalCache(
        selectedBook.id,
        selectedBook.createdAt,
        model.modelKey,
        nlp,
      );

      const resources: ReaderResources = {
        model,
        lemmaDict,
        lexicon: loadLexicon(),
        nlp,
        lexicalAnalysisCache,
      };
      resourcesRef.current = resources;

      bookRef.current = selectedBook;
      setBook(selectedBook);
      recomputeVisibleAnalysis(selectedBook, resources, 'reset');
    } catch (error) {
      if (readerLoadRunIdRef.current !== loadRunId) return;
      console.error('reader-load-failed', { error, bookId });
      initialReaderLoadPendingRef.current = false;
      setInitialViewportReady(true);
    } finally {
      if (readerLoadRunIdRef.current === loadRunId) setIsLoading(false);
    }
  }, [beginReaderLoading, bookId, recomputeVisibleAnalysis]);

  useEffect(() => {
    bookRef.current = book;
  }, [book]);

  useEffect(() => {
    chapterAnalysisRef.current = chapterAnalysis;
  }, [chapterAnalysis]);

  useEffect(() => {
    definitionsByLemmaRef.current = definitionsByLemma;
  }, [definitionsByLemma]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    if (settings.wsdMode !== 'none') {
      startWsdModel(settings.wsdMode);
    } else {
      stopWsdModel();
    }
    return () => stopWsdModel();
  }, [settings.wsdMode]);

  useEffect(() => {
    assistanceEnabledRef.current = assistanceEnabled;
  }, [assistanceEnabled]);

  useEffect(() => {
    const resources = resourcesRef.current;
    if (!book || !resources || isLoading) {
      return;
    }
    recomputeVisibleAnalysis(book, resources, 'reset');
  }, [
    assistanceEnabled,
    book,
    isLoading,
    recomputeVisibleAnalysis,
    settings.readingMode,
    settings.fontChoice,
    settings.fontSize,
    settings.lineSpacing,
    settings.pageWidth,
    settings.maxWordsPerParagraph,
    settings.deduplicationRadius,
    settings.knowledgeThreshold,
    settings.englishVariant,
    settings.wsdMode,
    settings.wsdReductionLevel,
    settings.wsdContextUnit,
    settings.wsdContextSize,
  ]);

  useEffect(() => {
    void loadReaderState();
    const unsubscribe = listenStateUpdated(() => {
      const profileState = loadProfileState();
      if (readerProfileIdRef.current !== profileState.activeProfileId) {
        if (progressPersistTimeoutRef.current !== null) {
          window.clearTimeout(progressPersistTimeoutRef.current);
          progressPersistTimeoutRef.current = null;
        }
        if (profileState.profiles.some((profile) => profile.id === readerProfileIdRef.current)) {
          persistCurrentChapterProgressRef.current(true);
        }
        void loadReaderState();
        return;
      }
      const resources = resourcesRef.current;
      const currentBook = bookRef.current;
      if (!currentBook || !resources) {
        void loadReaderState();
        return;
      }
      const anchorParagraphIndex = pendingAnalysisAnchorIndexRef.current;
      pendingAnalysisAnchorIndexRef.current = null;
      recomputeVisibleAnalysis(currentBook, resources, 'preserve', anchorParagraphIndex ?? undefined);
    });
    return () => {
      readerLoadRunIdRef.current += 1;
      bookRef.current = null;
      unsubscribe();
    };
  }, [loadReaderState, recomputeVisibleAnalysis]);

  useEffect(() => () => {
    clearDeferredHandle(deferredAnalysisHandleRef.current);
    deferredAnalysisHandleRef.current = null;
    if (bookmarkFeedbackTimeoutRef.current !== null) window.clearTimeout(bookmarkFeedbackTimeoutRef.current);
    if (layoutRestoreTimeoutRef.current !== null) window.clearTimeout(layoutRestoreTimeoutRef.current);
    if (progressPersistTimeoutRef.current !== null) window.clearTimeout(progressPersistTimeoutRef.current);
  }, []);

  const recordPrerenderLayout = useCallback((entry: PreparedChapterOpening, layout: ReaderPaginationLayout): void => {
    if (preparedChapterOpeningsRef.current.get(entry.chapterIndex) !== entry
      || layout.layoutKey !== entry.layoutKey
      || layout.chapterIndex !== entry.chapterIndex) return;
    if (entry.layout?.signature === layout.signature) return;
    entry.layout = layout;
    entry.previewError = null;
    setNextChapterPreloadRevision((revision) => revision + 1);
  }, []);

  const recordPrerenderError = useCallback((entry: PreparedChapterOpening, error: Error): void => {
    if (preparedChapterOpeningsRef.current.get(entry.chapterIndex) !== entry) return;
    if (entry.previewError?.message === error.message) return;
    entry.previewError = error;
    console.error('reader-chapter-prerender-failed', {
      bookId: entry.bookId,
      chapterIndex: entry.chapterIndex,
      error,
    });
    setNextChapterPreloadRevision((revision) => revision + 1);
  }, []);

  useEffect(() => {
    const selectedBook = bookRef.current;
    if (!book || !selectedBook || selectedBook.id !== book.id || !initialViewportReady || settings.readingMode !== 'page') return;
    const chapterNumber = clampChapterNumber(selectedBook, selectedBook.currentChapter);
    const nextChapterNumber = adjacentReadingChapter(selectedBook.chapters, chapterNumber, 1);
    const previousChapterNumber = adjacentReadingChapter(selectedBook.chapters, chapterNumber, -1);
    const targetChapterIndexes = [...new Set([nextChapterNumber - 1, previousChapterNumber - 1])]
      .filter((chapterIndex) => chapterIndex >= 0 && chapterIndex < selectedBook.chapters.length
        && chapterIndex !== chapterNumber - 1);
    const retainedChapterIndexes = new Set([chapterNumber - 1, ...targetChapterIndexes]);
    const profile = getActiveProfile(loadProfileState());
    const profileKey = JSON.stringify(profile);
    const layoutKeyForChapter = (chapterIndex: number): string => readerPaginationLayoutKey(
      selectedBook,
      readerProfileIdRef.current,
      profileKey,
      chapterIndex,
      viewportSize.width,
      viewportSize.height,
      paginationPageHeight,
      settings,
      assistanceEnabled,
    );
    for (const [chapterIndex, entry] of preparedChapterOpeningsRef.current) {
      if (!retainedChapterIndexes.has(chapterIndex) || entry.layoutKey !== layoutKeyForChapter(chapterIndex)) {
        preparedChapterOpeningsRef.current.delete(chapterIndex);
      }
    }
    for (const [chapterIndex, controller] of chapterPrerenderControllersRef.current) {
      const entry = preparedChapterOpeningsRef.current.get(chapterIndex);
      if (!entry || !retainedChapterIndexes.has(chapterIndex)) {
        controller.abort();
        chapterPrerenderControllersRef.current.delete(chapterIndex);
      }
    }

    const resources = resourcesRef.current;
    if (assistanceEnabled && !resources) return;
    const settingsKey = JSON.stringify(settings);
    const entriesToPrepare: { entry: PreparedChapterOpening; controller: AbortController }[] = [];
    targetChapterIndexes.forEach((chapterIndex) => {
      const chapter = selectedBook.chapters[chapterIndex];
      if (!chapter) return;
      const layoutKey = layoutKeyForChapter(chapterIndex);
      const existing = preparedChapterOpeningsRef.current.get(chapterIndex);
      if (existing?.layoutKey === layoutKey
        && (existing.cardPreloadComplete || existing.previewError !== null)) return;
      const entry: PreparedChapterOpening = existing?.layoutKey === layoutKey
        ? existing
        : {
          bookId: selectedBook.id,
          bookUpdatedAt: selectedBook.updatedAt,
          chapterIndex,
          chapter,
          layoutKey,
          settingsKey,
          profileKey,
          analyses: new Map(),
          scores: new Map(),
          readyCards: new Set(),
          analysisComplete: false,
          cardPreloadComplete: false,
          viewportWidth: viewportSize.width,
          viewportHeight: viewportSize.height,
          layout: null,
          previewError: null,
        };
      preparedChapterOpeningsRef.current.set(chapterIndex, entry);
      chapterPrerenderControllersRef.current.get(chapterIndex)?.abort();
      const controller = new AbortController();
      chapterPrerenderControllersRef.current.set(chapterIndex, controller);
      entriesToPrepare.push({ entry, controller });
    });
    if (entriesToPrepare.length === 0) return;

    let active = true;
    let currentlyPreparingEntry: PreparedChapterOpening | null = null;
    const handle = scheduleDeferredTask(() => {
      void (async () => {
        for (const { entry, controller } of entriesToPrepare) {
          if (!active || controller.signal.aborted) return;
          currentlyPreparingEntry = entry;
          const targetBook: ImportedBook = {
            ...selectedBook,
            currentChapter: entry.chapterIndex + 1,
            currentChapterProgress: 0,
            location: { chapterIndex: entry.chapterIndex, blockIndex: 0, textOffset: 0 },
            pagePosition: undefined,
          };
          const cardTasks: Promise<void>[] = [];
          const preloadCard = async (analysis: ParagraphAnalysis, index: number, target: DefinitionTarget): Promise<void> => {
            const targetKey = `${index}:${definitionTargetKey(target)}`;
            requestAutomaticDefinition(resources!, target);
            const request = automaticDefinitionRequestsRef.current.get(normalizeToken(target.lemma));
            if (request) await request;
            if (controller.signal.aborted) return;
            const rawDefinition = definitionsByLemmaRef.current.get(normalizeToken(target.lemma));
            if (!rawDefinition) {
              entry.readyCards.add(targetKey);
              return;
            }
            const definition = resolveLexiconEntry(rawDefinition, target);
            if (settings.wsdMode === 'none' || wordNetGlosses(definition).length <= 1) {
              entry.readyCards.add(targetKey);
              return;
            }
            const context = contextForCard(analysis, target);
            if (!context) throw new Error(`Missing prerender WSD context: chapter=${entry.chapterIndex} paragraph=${index} lemma=${target.lemma}`);
            const scoringContext = settings.wsdContextUnit === 'sentence'
              ? sentenceWindowForWsd(entry.chapter.paragraphs, index, context, settings.wsdContextSize)
              : paragraphWindowForWsd(entry.chapter.paragraphs, index, context, settings.wsdContextSize);
            await waitForWsdModelReady(settings.wsdMode, controller.signal);
            const scores = await scoreWordSenses(settings.wsdMode, scoringContext, definition, 'preload', controller.signal);
            if (controller.signal.aborted) return;
            entry.scores.set(targetKey, {
              key: JSON.stringify([settings.wsdMode, scoringContext, definition.word, wordNetGlosses(definition)]),
              scores,
            });
            entry.readyCards.add(targetKey);
          };
          if (assistanceEnabled) {
            const analyzer = createCachedChapterAnalyzer({
              settings,
              model: resources!.model,
              profile,
              lemmaDict: resources!.lemmaDict,
              nlp: resources!.nlp,
              maxCardsPerParagraph: 1,
              includeCards: false,
            }, resources!.lexicalAnalysisCache);
            const previousAnalyses = new Map<number, ParagraphAnalysis>();
            for (let paragraphIndex = 0; paragraphIndex < entry.chapter.paragraphs.length; paragraphIndex += 1) {
              await yieldForReaderPrerenderContinuation();
              if (!active || controller.signal.aborted) return;
              const analysis = buildParagraphAnalysisAtIndex(targetBook, paragraphIndex, analyzer);
              const selected: ParagraphAnalysis = {
                ...analysis,
                cardTargets: deduplicateParagraphCardTargets(analysis, paragraphIndex, previousAnalyses, settings),
              };
              previousAnalyses.set(paragraphIndex, selected);
              entry.analyses.set(paragraphIndex, selected);
              selected.cardTargets.forEach((target) => cardTasks.push(
                preloadCard(selected, paragraphIndex, target).catch((failure: unknown) => {
                  if (!controller.signal.aborted) {
                    console.error('reader-prerender-card-preload-failed', {
                      bookId: entry.bookId,
                      chapterIndex: entry.chapterIndex,
                      paragraphIndex,
                      lemma: target.lemma,
                      error: failure,
                    });
                    entry.readyCards.add(`${paragraphIndex}:${definitionTargetKey(target)}`);
                  }
                }),
              ));
            }
          } else {
            buildPlainChapterAnalysis(targetBook).forEach((analysis, paragraphIndex) => entry.analyses.set(paragraphIndex, analysis));
          }
          entry.analysisComplete = true;
          setNextChapterPreloadRevision((revision) => revision + 1);
          await Promise.all(cardTasks);
          if (!active || controller.signal.aborted) return;
          entry.cardPreloadComplete = true;
          setNextChapterPreloadRevision((revision) => revision + 1);
          if (chapterPrerenderControllersRef.current.get(entry.chapterIndex) === controller) {
            chapterPrerenderControllersRef.current.delete(entry.chapterIndex);
          }
        }
      })().catch((failure: unknown) => {
        const current = entriesToPrepare.find(({ entry }) => entry === currentlyPreparingEntry);
        if (!active || !current) return;
        if (current.controller.signal.aborted) return;
        const error = failure instanceof Error ? failure : new Error(`Reader chapter prerender failed: ${String(failure)}`);
        recordPrerenderError(current.entry, error);
      });
    }, 500);
    return () => {
      active = false;
      clearDeferredHandle(handle);
      entriesToPrepare.forEach(({ entry, controller }) => {
        controller.abort();
        if (chapterPrerenderControllersRef.current.get(entry.chapterIndex) === controller) {
          chapterPrerenderControllersRef.current.delete(entry.chapterIndex);
        }
      });
    };
  }, [
    assistanceEnabled,
    book?.currentChapter,
    book?.id,
    book?.updatedAt,
    initialViewportReady,
    paginationLayoutKey,
    paginationPageHeight,
    recordPrerenderError,
    requestAutomaticDefinition,
    settings,
    viewportSize.height,
    viewportSize.width,
  ]);

  useEffect(() => {
    const selectedBook = bookRef.current;
    const resources = resourcesRef.current;
    if (!book || !selectedBook || selectedBook.id !== book.id || !resources
      || !initialViewportReady || assistanceEnabled === false || settings.readingMode === 'page') return;
    const currentChapterNumber = clampChapterNumber(selectedBook, selectedBook.currentChapter);
    const nextChapterNumber = adjacentReadingChapter(selectedBook.chapters, currentChapterNumber, 1);
    if (nextChapterNumber === currentChapterNumber) return;
    const chapterIndex = nextChapterNumber - 1;
    const chapter = selectedBook.chapters[chapterIndex];
    if (!chapter) return;
    const profile = getActiveProfile(loadProfileState());
    const profileKey = JSON.stringify(profile);
    const pageHeight = Math.max(1, viewportSize.height - 136);
    const layoutKey = readerPaginationLayoutKey(
      selectedBook,
      readerProfileIdRef.current,
      profileKey,
      chapterIndex,
      viewportSize.width,
      viewportSize.height,
      pageHeight,
      settings,
      assistanceEnabled,
    );
    const retainedChapterIndexes = new Set([currentChapterNumber - 1, chapterIndex]);
    for (const [preparedChapterIndex] of preparedChapterOpeningsRef.current) {
      if (!retainedChapterIndexes.has(preparedChapterIndex)) {
        preparedChapterOpeningsRef.current.delete(preparedChapterIndex);
      }
    }
    for (const [preparedChapterIndex, controller] of chapterPrerenderControllersRef.current) {
      if (!retainedChapterIndexes.has(preparedChapterIndex)) {
        controller.abort();
        chapterPrerenderControllersRef.current.delete(preparedChapterIndex);
      }
    }
    const existing = preparedChapterOpeningsRef.current.get(chapterIndex);
    if (existing?.layoutKey === layoutKey && existing.analysisComplete) return;
    const entry: PreparedChapterOpening = existing?.layoutKey === layoutKey
      ? existing
      : {
        bookId: selectedBook.id,
        bookUpdatedAt: selectedBook.updatedAt,
        chapterIndex,
        chapter,
        layoutKey,
        settingsKey: JSON.stringify(settings),
        profileKey,
        analyses: new Map(),
        scores: new Map(),
        readyCards: new Set(),
        analysisComplete: false,
        cardPreloadComplete: false,
        viewportWidth: viewportSize.width,
        viewportHeight: viewportSize.height,
        layout: null,
        previewError: null,
      };
    preparedChapterOpeningsRef.current.set(chapterIndex, entry);
    chapterPrerenderControllersRef.current.get(chapterIndex)?.abort();
    const controller = new AbortController();
    chapterPrerenderControllersRef.current.set(chapterIndex, controller);
    const width = document.querySelector('[data-testid="text-column"]')?.getBoundingClientRect().width ?? viewportSize.width;
    const charactersPerLine = Math.max(1, width / (settings.fontSize * 0.45));
    const characterBudget = Math.min(MAX_PRELOAD_CHARACTERS, Math.ceil(2 * charactersPerLine
      * Math.max(1, viewportSize.height / (settings.fontSize * 1.4))));
    const targetBook: ImportedBook = {
      ...selectedBook,
      currentChapter: nextChapterNumber,
      currentChapterProgress: 0,
      location: { chapterIndex, blockIndex: 0, textOffset: 0 },
      pagePosition: undefined,
    };
    const analyzer = createCachedChapterAnalyzer({
      settings,
      model: resources.model,
      profile,
      lemmaDict: resources.lemmaDict,
      nlp: resources.nlp,
      maxCardsPerParagraph: 1,
      includeCards: false,
    }, resources.lexicalAnalysisCache);
    const previousAnalyses = new Map(entry.analyses);
    const cardTasks: Promise<void>[] = [];
    const preloadCard = async (analysis: ParagraphAnalysis, paragraphIndex: number, target: DefinitionTarget): Promise<void> => {
      const targetKey = `${paragraphIndex}:${definitionTargetKey(target)}`;
      requestAutomaticDefinition(resources, target);
      const request = automaticDefinitionRequestsRef.current.get(normalizeToken(target.lemma));
      if (request) await request;
      if (controller.signal.aborted) return;
      const rawDefinition = definitionsByLemmaRef.current.get(normalizeToken(target.lemma));
      if (!rawDefinition) {
        entry.readyCards.add(targetKey);
        return;
      }
      const definition = resolveLexiconEntry(rawDefinition, target);
      if (settings.wsdMode === 'none' || wordNetGlosses(definition).length <= 1) {
        entry.readyCards.add(targetKey);
        return;
      }
      const context = contextForCard(analysis, target);
      if (!context) throw new Error(`Missing next-chapter WSD context: chapter=${nextChapterNumber} paragraph=${paragraphIndex} lemma=${target.lemma}`);
      const scoringContext = settings.wsdContextUnit === 'sentence'
        ? sentenceWindowForWsd(chapter.paragraphs, paragraphIndex, context, settings.wsdContextSize)
        : paragraphWindowForWsd(chapter.paragraphs, paragraphIndex, context, settings.wsdContextSize);
      await waitForWsdModelReady(settings.wsdMode, controller.signal);
      const scores = await scoreWordSenses(settings.wsdMode, scoringContext, definition, 'preload', controller.signal);
      if (controller.signal.aborted) return;
      entry.scores.set(targetKey, {
        key: JSON.stringify([settings.wsdMode, scoringContext, definition.word, wordNetGlosses(definition)]),
        scores,
      });
      entry.readyCards.add(targetKey);
    };
    let active = true;
    const handle = scheduleDeferredTask(() => {
      void (async () => {
        let characters = [...entry.analyses.values()].reduce((total, analysis) => total + analysis.paragraphText.length, 0);
        let cardCount = [...entry.analyses.values()].reduce((total, analysis) => total + analysis.cardTargets.length, 0);
        const paragraphLimit = Math.min(MAX_PRELOAD_PARAGRAPHS, chapter.paragraphs.length);
        for (let paragraphIndex = entry.analyses.size; paragraphIndex < paragraphLimit && characters < characterBudget; paragraphIndex += 1) {
          if (characters + chapter.paragraphs[paragraphIndex].length > MAX_PRELOAD_CHARACTERS) break;
          await yieldForReaderPrerenderContinuation();
          await waitForReaderScrollToSettle();
          if (!active || controller.signal.aborted) return;
          const analysis = buildParagraphAnalysisAtIndex(targetBook, paragraphIndex, analyzer);
          const selected: ParagraphAnalysis = {
            ...analysis,
            cardTargets: deduplicateParagraphCardTargets(analysis, paragraphIndex, previousAnalyses, settings),
          };
          if (cardCount + selected.cardTargets.length > MAX_PRELOAD_CARDS) break;
          previousAnalyses.set(paragraphIndex, selected);
          entry.analyses.set(paragraphIndex, selected);
          cardCount += selected.cardTargets.length;
          characters += Math.max(charactersPerLine, analysis.paragraphText.length);
          selected.cardTargets.forEach((target) => cardTasks.push(preloadCard(selected, paragraphIndex, target).catch((failure: unknown) => {
            if (!controller.signal.aborted) {
              console.error('next-chapter-preload-card-failed', {
                bookId: selectedBook.id,
                chapter: nextChapterNumber,
                paragraphIndex,
                lemma: target.lemma,
                error: failure,
              });
              entry.readyCards.add(`${paragraphIndex}:${definitionTargetKey(target)}`);
            }
          })));
        }
        if (!active || controller.signal.aborted) return;
        entry.analysisComplete = true;
        setNextChapterPreloadRevision((revision) => revision + 1);
        await Promise.all(cardTasks);
        if (!active || controller.signal.aborted) return;
        entry.cardPreloadComplete = true;
        setNextChapterPreloadRevision((revision) => revision + 1);
        if (chapterPrerenderControllersRef.current.get(chapterIndex) === controller) {
          chapterPrerenderControllersRef.current.delete(chapterIndex);
        }
      })().catch((failure: unknown) => {
        if (!active || controller.signal.aborted) return;
        console.error('next-chapter-preload-failed', {
          bookId: selectedBook.id,
          chapter: nextChapterNumber,
          error: failure,
        });
      });
    }, 1000);
    return () => {
      active = false;
      clearDeferredHandle(handle);
      controller.abort();
      if (chapterPrerenderControllersRef.current.get(chapterIndex) === controller) {
        chapterPrerenderControllersRef.current.delete(chapterIndex);
      }
    };
  }, [
    assistanceEnabled,
    book?.currentChapter,
    book?.id,
    book?.updatedAt,
    initialViewportReady,
    requestAutomaticDefinition,
    settings,
    viewportSize.height,
    viewportSize.width,
    waitForReaderScrollToSettle,
  ]);

  const markLemma = (lemma: string, known: boolean, sourceParagraphIndex?: number) => {
    if (typeof sourceParagraphIndex === 'number' && Number.isFinite(sourceParagraphIndex)) {
      pendingAnalysisAnchorIndexRef.current = sourceParagraphIndex;
    } else {
      pendingAnalysisAnchorIndexRef.current = null;
    }
    upsertObservation(lemma, known);
  };

  const scheduleChapterProgressPersist = useCallback(() => {
    if (progressPersistTimeoutRef.current !== null) {
      window.clearTimeout(progressPersistTimeoutRef.current);
    }
    progressPersistTimeoutRef.current = window.setTimeout(() => {
      progressPersistTimeoutRef.current = null;
      persistCurrentChapterProgress(false);
    }, 250);
  }, [persistCurrentChapterProgress]);

  const restoreCurrentChapterProgress = useCallback((targetBook: ImportedBook) => {
    if (settings.readingMode === 'page') {
      const location = targetBook.location ?? readerLocationFromLegacyProgress(
        targetBook,
        targetBook.currentChapter,
        targetBook.currentChapterProgress,
      );
      pageAnchorLocationRef.current = location;
      currentLocationRef.current = location;
      lastStableLocationRef.current = location;
      pendingReaderAnchorRef.current = null;
      return;
    }
    if (pendingReaderAnchorRef.current) {
      document.getElementById(pendingReaderAnchorRef.current)?.scrollIntoView({ behavior: 'auto', block: 'start' });
      return;
    }
    if (targetBook.location && readerRootRef.current) {
      restoreReaderLocation(readerRootRef.current, targetBook.location, 72);
      return;
    }
    const targetScrollTop = calculateScrollTopFromProgress(targetBook.currentChapterProgress);
    window.scrollTo({ top: targetScrollTop, behavior: 'auto' });
  }, [settings.readingMode]);

  const navigateToReaderLocation = useCallback((rawLocation: ReaderLocation, pushHistory: boolean): void => {
    const currentBook = bookRef.current;
    if (!currentBook) return;
    const location = resolveReaderLocation(currentBook, rawLocation);
    const previousLocation = captureCurrentReaderLocation()
      ?? currentBook.location
      ?? readerLocationFromLegacyProgress(currentBook, currentBook.currentChapter, currentBook.currentChapterProgress);
    if (pushHistory && !readerLocationsEqual(previousLocation, location)) {
      navigationHistoryRef.current = [...navigationHistoryRef.current, previousLocation];
      returnLocationRef.current = previousLocation;
      setReturnLocation(previousLocation);
    }
    setWordPopups([]);
    setNavigationOpen(false);
    const chapter = currentBook.chapters[location.chapterIndex];
    const chapterProgress = chapter
      ? chapterProgressAtLocation(chapter, location.blockIndex, location.textOffset)
      : 0;
    const nextBook: ImportedBook = {
      ...currentBook,
      currentChapter: location.chapterIndex + 1,
      currentChapterProgress: chapterProgress,
      location,
      pagePosition: undefined,
    };
    saveReaderBookProgress(nextBook);
    currentLocationRef.current = location;
    lastStableLocationRef.current = location;
    canonicalAnchorCapturedRef.current = true;
    isBookFinishedRef.current = readerLocationsEqual(location, lastLinearReaderLocation(currentBook));
    setCurrentLocation(location);
    setReadingProgressPercent(bookProgressAtLocation(currentBook, location) * 100);
    if (location.chapterIndex + 1 !== currentBook.currentChapter) {
      pendingReaderAnchorRef.current = null;
      pageAnchorLocationRef.current = location;
      pendingPageAnchorRef.current = location;
      openReaderChapter(nextBook, 'anchor');
      return;
    }
    bookRef.current = nextBook;
    if (settings.readingMode === 'page') {
      pageAnchorLocationRef.current = location;
      pendingPageAnchorRef.current = location;
      if (pagination.isReady && pagination.layout) {
        const pageIndex = readerPageIndexForLocation(pagination.layout.pages, location);
        if (pageIndex !== null) {
          const pageRefreshAnchor = pageRefreshAnchorRef.current;
          if (pageRefreshAnchor) {
            pageRefreshAnchorRef.current = { ...pageRefreshAnchor, location };
          }
          commitReaderPage(pageIndex, pagination.layout);
        }
      }
      return;
    }
    window.requestAnimationFrame(() => {
      if (readerRootRef.current) restoreReaderLocation(readerRootRef.current, location, 72);
    });
  }, [captureCurrentReaderLocation, commitReaderPage, openReaderChapter, pagination.isReady, pagination.layout, saveReaderBookProgress, settings.readingMode]);

  const returnToPreviousPosition = useCallback((): void => {
    const previousLocation = navigationHistoryRef.current.pop() ?? returnLocationRef.current;
    if (!previousLocation) return;
    returnLocationRef.current = navigationHistoryRef.current[navigationHistoryRef.current.length - 1] ?? null;
    setReturnLocation(returnLocationRef.current);
    navigateToReaderLocation(previousLocation, false);
  }, [navigateToReaderLocation]);

  const markBookFinished = useCallback((): void => {
    const currentBook = bookRef.current;
    if (!currentBook) return;
    navigateToReaderLocation(lastLinearReaderLocation(currentBook), true);
  }, [navigateToReaderLocation]);

  const updateCurrentChapter = async (delta: -1 | 1) => {
    if (!book) {
      return;
    }
    persistCurrentChapterProgress(true);
    const currentChapterNumber = clampChapterNumber(book, book.currentChapter);
    const nextChapter = adjacentReadingChapter(book.chapters, currentChapterNumber, delta);
    if (nextChapter === currentChapterNumber) {
      return;
    }

    const nextBook: ImportedBook = {
      ...book,
      currentChapter: nextChapter,
      currentChapterProgress: 0,
      location: { chapterIndex: nextChapter - 1, blockIndex: 0, textOffset: 0 },
      pagePosition: undefined,
    };
    saveReaderBookProgress(nextBook);
    currentLocationRef.current = nextBook.location ?? null;
    lastStableLocationRef.current = nextBook.location ?? null;
    canonicalAnchorCapturedRef.current = Boolean(nextBook.location);
    pageAnchorLocationRef.current = nextBook.location ?? null;
    pendingPageAnchorRef.current = nextBook.location ?? null;
    isBookFinishedRef.current = false;
    if (nextBook.location) {
      setCurrentLocation(nextBook.location);
      setReadingProgressPercent(bookProgressAtLocation(nextBook, nextBook.location) * 100);
    }
    openReaderChapter(nextBook, delta < 0 ? 'last' : 'first');
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const navigatePage = useCallback((delta: -1 | 1): void => {
    if (!pagination.isReady || !pagination.layout) return;
    const targetPageIndex = currentPageIndexRef.current + delta;
    if (targetPageIndex >= 0 && targetPageIndex < pagination.layout.pages.length) {
      setFullscreenToolbarOpen(false);
      const pageRefreshAnchor = pageRefreshAnchorRef.current;
      const targetPage = pagination.layout.pages[targetPageIndex];
      if (pageRefreshAnchor && targetPage) {
        pageRefreshAnchorRef.current = { ...pageRefreshAnchor, location: targetPage.startLocation };
      }
      commitReaderPage(targetPageIndex, pagination.layout);
      return;
    }

    const currentBook = bookRef.current;
    if (!currentBook) return;
    const currentChapterNumber = clampChapterNumber(currentBook, currentBook.currentChapter);
    const nextChapterNumber = adjacentReadingChapter(currentBook.chapters, currentChapterNumber, delta);
    if (nextChapterNumber === currentChapterNumber) return;
    setFullscreenToolbarOpen(false);
    persistCurrentChapterProgress(true);
    const chapterIndex = nextChapterNumber - 1;
    const location = delta < 0
      ? lastReaderLocationInChapter(currentBook, chapterIndex)
      : { chapterIndex, blockIndex: 0, textOffset: 0 };
    const nextChapter = currentBook.chapters[chapterIndex];
    const chapterProgress = nextChapter
      ? chapterProgressAtLocation(nextChapter, location.blockIndex, location.textOffset)
      : 0;
    const nextBook: ImportedBook = {
      ...currentBook,
      currentChapter: nextChapterNumber,
      currentChapterProgress: chapterProgress,
      location,
      pagePosition: undefined,
    };
    saveReaderBookProgress(nextBook);
    currentLocationRef.current = location;
    lastStableLocationRef.current = location;
    pageAnchorLocationRef.current = location;
    pendingPageAnchorRef.current = location;
    canonicalAnchorCapturedRef.current = true;
    isBookFinishedRef.current = false;
    setCurrentLocation(location);
    setReadingProgressPercent(bookProgressAtLocation(nextBook, location) * 100);
    currentPageIndexRef.current = 0;
    setCurrentPageIndex(0);
    openReaderChapter(nextBook, delta < 0 ? 'last' : 'first');
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [commitReaderPage, openReaderChapter, pagination.isReady, pagination.layout, persistCurrentChapterProgress, saveReaderBookProgress]);

  const handlePagePointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (settings.readingMode !== 'page' || event.pointerType !== 'touch' || !event.isPrimary) return;
    const target = event.target;
    if (target instanceof Element && target.closest('button, a, input, textarea, select, [role="dialog"], [data-definition-card="true"]')) return;
    pageSwipeStartRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };

  const handlePagePointerUp = (event: ReactPointerEvent<HTMLElement>): void => {
    const start = pageSwipeStartRef.current;
    pageSwipeStartRef.current = null;
    if (!start || start.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (fullscreenPageMode && fullscreenToolbarOpen
      && deltaY < -48 && Math.abs(deltaY) > Math.abs(deltaX) * 1.25) {
      setFullscreenToolbarOpen(false);
      suppressPageSwipeClickUntilRef.current = performance.now() + 500;
      return;
    }
    if (Math.abs(deltaX) < 48 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.25) return;
    suppressPageSwipeClickUntilRef.current = performance.now() + 500;
    navigatePage(deltaX < 0 ? 1 : -1);
  };

  const handlePagePointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const start = pageSwipeStartRef.current;
    if (!start || start.pointerId !== event.pointerId || !fullscreenPageMode || !fullscreenToolbarOpen) return;
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (deltaY < -48 && Math.abs(deltaY) > Math.abs(deltaX) * 1.25) {
      pageSwipeStartRef.current = null;
      setFullscreenToolbarOpen(false);
      suppressPageSwipeClickUntilRef.current = performance.now() + 500;
    }
  };

  const handlePagePointerCancel = (event: ReactPointerEvent<HTMLElement>): void => {
    if (pageSwipeStartRef.current?.pointerId === event.pointerId) pageSwipeStartRef.current = null;
  };

  const handlePageScreenClick = (event: ReactMouseEvent<HTMLElement>): void => {
    if (performance.now() <= suppressPageSwipeClickUntilRef.current) {
      suppressPageSwipeClickUntilRef.current = 0;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = event.target;
    const clickedHeader = target instanceof Element && target.closest('header');
    const clickedReaderText = target instanceof Element
      && target.closest('[data-reader-text-block], .reader-text, [data-word-popup-trigger="true"]');
    if (fullscreenPageMode) {
      if (fullscreenToolbarOpen) {
        if (clickedHeader) return;
        setFullscreenToolbarOpen(false);
        if (clickedReaderText) return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.clientY <= fullscreenTopSpacing) {
        setFullscreenToolbarOpen(true);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (clickedReaderText) return;
    }
    if (settings.readingMode !== 'page' || !pageModeReady) return;
    if (target instanceof Element && target.closest('button, a, input, textarea, select, [role="button"], [role="dialog"], [data-definition-card="true"], [data-word-popup-index]')) return;
    const edgeWidth = Math.min(120, Math.max(56, window.innerWidth * 0.14));
    if (event.clientX <= edgeWidth) {
      event.preventDefault();
      event.stopPropagation();
      navigatePage(-1);
      return;
    }
    if (event.clientX >= window.innerWidth - edgeWidth) {
      event.preventDefault();
      event.stopPropagation();
      navigatePage(1);
    }
  };

  useEffect(() => {
    if (!fullscreenPageMode || !fullscreenToolbarOpen) return;
    const handleFullscreenEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setFullscreenToolbarOpen(false);
      event.preventDefault();
    };
    window.addEventListener('keydown', handleFullscreenEscape);
    return () => window.removeEventListener('keydown', handleFullscreenEscape);
  }, [fullscreenPageMode, fullscreenToolbarOpen]);

  useEffect(() => {
    if (!book || isLoading) {
      return;
    }
    isRestoringProgressRef.current = true;
    if (delayedRestoreTimeoutRef.current !== null) {
      window.clearTimeout(delayedRestoreTimeoutRef.current);
      delayedRestoreTimeoutRef.current = null;
    }

    if (book.currentChapterProgress === 0 && !pendingReaderAnchorRef.current) {
      const restoreFrame = requestAnimationFrame(() => {
        restoreCurrentChapterProgress(book);
        if (initialReaderLoadPendingRef.current) setInitialProgressRestored(true);
        isRestoringProgressRef.current = false;
      });
      return () => window.cancelAnimationFrame(restoreFrame);
    }
    const restoreFrame = requestAnimationFrame(() => {
      restoreCurrentChapterProgress(book);
    });
    delayedRestoreTimeoutRef.current = window.setTimeout(() => {
      restoreCurrentChapterProgress(book);
      if (initialReaderLoadPendingRef.current) {
        initialViewportParagraphsRef.current = null;
        completedInitialAnalysisRef.current = new Set();
        setInitialProgressRestored(true);
      }
      isRestoringProgressRef.current = false;
      pendingReaderAnchorRef.current = null;
      delayedRestoreTimeoutRef.current = null;
    }, 900);
    return () => {
      window.cancelAnimationFrame(restoreFrame);
      if (delayedRestoreTimeoutRef.current !== null) {
        window.clearTimeout(delayedRestoreTimeoutRef.current);
        delayedRestoreTimeoutRef.current = null;
      }
    };
  }, [book, isLoading, restoreCurrentChapterProgress]);

  useEffect(() => {
    let lastTouchY: number | null = null;
    let scrollbarPointerId: number | null = null;
    const recordScrollActivity = () => {
      lastScrollActivityAtRef.current = performance.now();
    };
    const recordWheelScrollActivity = (event: WheelEvent) => {
      if (event.deltaY !== 0) {
        scrollDirectionRef.current = event.deltaY > 0 ? 1 : -1;
      }
      recordScrollActivity();
    };
    const recordTouchStart = (event: TouchEvent) => {
      lastTouchY = event.touches[0]?.clientY ?? null;
    };
    const recordTouchScrollActivity = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? null;
      if (y !== null && lastTouchY !== null && y !== lastTouchY) {
        scrollDirectionRef.current = y < lastTouchY ? 1 : -1;
      }
      lastTouchY = y;
      recordScrollActivity();
    };
    const recordScrollbarPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.clientX >= document.documentElement.clientWidth) {
        scrollbarPointerId = event.pointerId;
      }
    };
    const recordScrollbarPointerUp = (event: PointerEvent) => {
      if (event.pointerId === scrollbarPointerId) {
        scrollbarPointerId = null;
        scrollDirectionRef.current = 0;
      }
    };
    const recordKeyboardScrollActivity = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
        return;
      }
      if (SCROLL_KEYS.has(event.key)) {
        scrollDirectionRef.current = event.key === 'ArrowUp' || event.key === 'PageUp'
          || event.key === 'Home' || (event.key === ' ' && event.shiftKey) ? -1 : 1;
        recordScrollActivity();
      }
    };
    const handleScroll = () => {
      const y = window.scrollY;
      const previousY = lastScrollY.current;
      lastScrollY.current = y;
      if (y <= 1) setHeaderVisible(true);
      if (isRestoringProgressRef.current) {
        return;
      }
      const recentManualScroll = performance.now() - lastScrollActivityAtRef.current < 500;
      const capturedLocation = captureCurrentReaderLocation();
      if (capturedLocation) {
        currentLocationRef.current = capturedLocation;
        lastStableLocationRef.current = capturedLocation;
        const activeBook = bookRef.current;
        if (activeBook && recentManualScroll && isBookFinishedRef.current
          && !readerLocationsEqual(capturedLocation, lastLinearReaderLocation(activeBook))) {
          isBookFinishedRef.current = false;
        }
      }
      const currentBook = bookRef.current;
      const lastLinearChapterIndex = currentBook?.chapters.findLastIndex((chapter) => chapter.linear !== false) ?? -1;
      const reachedDocumentBottom = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight) <= 2;
      if (currentBook && reachedDocumentBottom && recentManualScroll
        && currentBook.currentChapter - 1 === lastLinearChapterIndex) {
        const endLocation = lastLinearReaderLocation(currentBook);
        const finalChapter = currentBook.chapters[endLocation.chapterIndex];
        const finishedBook: ImportedBook = {
          ...currentBook,
          currentChapter: endLocation.chapterIndex + 1,
          currentChapterProgress: finalChapter
            ? chapterProgressAtLocation(finalChapter, endLocation.blockIndex, endLocation.textOffset)
            : 1,
          location: endLocation,
        };
        saveReaderBookProgress(finishedBook);
        bookRef.current = finishedBook;
        currentLocationRef.current = endLocation;
        lastStableLocationRef.current = endLocation;
        isBookFinishedRef.current = true;
        setCurrentLocation(endLocation);
        setReadingProgressPercent(100);
      }
      if (y > previousY && y > 100 && (scrollDirectionRef.current === 1 || scrollbarPointerId !== null)) {
        setHeaderVisible(false);
      } else if (y < previousY && (scrollDirectionRef.current === -1 || scrollbarPointerId !== null)) {
        setHeaderVisible(true);
      }
      scheduleChapterProgressPersist();
    };
    window.addEventListener('wheel', recordWheelScrollActivity, { passive: true });
    window.addEventListener('touchstart', recordTouchStart, { passive: true });
    window.addEventListener('touchmove', recordTouchScrollActivity, { passive: true });
    window.addEventListener('pointerdown', recordScrollbarPointerDown);
    window.addEventListener('pointerup', recordScrollbarPointerUp);
    window.addEventListener('pointercancel', recordScrollbarPointerUp);
    window.addEventListener('keydown', recordKeyboardScrollActivity);
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('wheel', recordWheelScrollActivity);
      window.removeEventListener('touchstart', recordTouchStart);
      window.removeEventListener('touchmove', recordTouchScrollActivity);
      window.removeEventListener('pointerdown', recordScrollbarPointerDown);
      window.removeEventListener('pointerup', recordScrollbarPointerUp);
      window.removeEventListener('pointercancel', recordScrollbarPointerUp);
      window.removeEventListener('keydown', recordKeyboardScrollActivity);
      window.removeEventListener('scroll', handleScroll);
    };
  }, [captureCurrentReaderLocation, saveReaderBookProgress, scheduleChapterProgressPersist]);

  useEffect(() => () => {
    if (progressPersistTimeoutRef.current !== null) {
      window.clearTimeout(progressPersistTimeoutRef.current);
      progressPersistTimeoutRef.current = null;
    }
    if (delayedRestoreTimeoutRef.current !== null) {
      window.clearTimeout(delayedRestoreTimeoutRef.current);
      delayedRestoreTimeoutRef.current = null;
    }
    isRestoringProgressRef.current = false;
  }, []);

  useEffect(() => {
    const persistOnPageHide = () => {
      persistCurrentChapterProgress(true);
    };
    const persistOnVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        persistCurrentChapterProgress(true);
      }
    };
    window.addEventListener('pagehide', persistOnPageHide);
    document.addEventListener('visibilitychange', persistOnVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', persistOnPageHide);
      document.removeEventListener('visibilitychange', persistOnVisibilityChange);
    };
  }, [persistCurrentChapterProgress]);

  const getTextFontClasses = () => cn(
    settings.fontChoice === 'Sans' ? 'font-sans' : 'font-serif',
    settings.lineSpacing === 'Compact' ? 'leading-snug' :
    settings.lineSpacing === 'Relaxed' ? 'leading-loose' : 'leading-relaxed'
  );

  const getOuterWidthClass = () =>
    settings.pageWidth === 'Narrow' ? 'max-w-[576px]' :
    settings.pageWidth === 'Wide' ? 'max-w-[832px]' : 'max-w-[704px]';

  const deleteCurrentBook = async () => {
    if (!book) {
      return;
    }
    const confirmed = window.confirm(`Delete "${book.title}" from your library?`);
    if (!confirmed) {
      return;
    }
    persistCurrentChapterProgress(true);
    try {
      await deleteBookById(book.id);
      bookRef.current = null;
      setLocation('/');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete book.';
      window.alert(message);
    }
  };

  const createWordPopupFromRects = useCallback((
    anchor: PopupAnchorRect,
    horizontalAnchor: PopupAnchorRect,
    lookupCandidates: DefinitionLookupCandidate[],
    sourceParagraphIndex: number,
    triggerDefinitionText: string | null,
    contextText: string,
  ): WordPopupState => {
    const initialCandidate = lookupCandidates[0];
    if (!initialCandidate) {
      throw new RangeError('Cannot create a word popup without lookup candidates.');
    }
    const position = calculateWordPopupPosition(
      anchor,
      horizontalAnchor,
      280,
      0,
      window.innerWidth,
      window.innerHeight,
    );
    return {
      id: nextWordPopupIdRef.current++,
      lookupCandidates,
      target: initialCandidate.target,
      lookupWord: normalizeToken(initialCandidate.lookupWord),
      triggerSelection: triggerDefinitionText === null ? null : {
        definitionText: triggerDefinitionText,
        end: initialCandidate.selectionEnd,
        start: initialCandidate.selectionStart,
      },
      definition: null,
      definitionStatus: 'loading',
      top: position.top,
      left: position.left,
      anchorRect: anchor,
      horizontalAnchorRect: horizontalAnchor,
      sourceParagraphIndex,
      contextText,
      contextStart: initialCandidate.selectionStart,
      contextEnd: initialCandidate.selectionEnd,
      contextIsBookParagraph: triggerDefinitionText === null,
      originalContext: triggerDefinitionText === null
        ? { text: contextText, start: initialCandidate.selectionStart, end: initialCandidate.selectionEnd }
        : null,
      parentContexts: [],
    };
  }, []);

  const createWordPopupFromElement = useCallback((
    element: HTMLElement,
    lookupCandidates: DefinitionLookupCandidate[],
    sourceParagraphIndex: number,
    triggerDefinitionText: string,
  ): WordPopupState => {
    const rect = capturePopupAnchorRect(element.getBoundingClientRect());
    const definitionCard = element.closest<HTMLElement>('[data-definition-card="true"]');
    const horizontalRect = definitionCard
      ? capturePopupAnchorRect(definitionCard.getBoundingClientRect())
      : rect;
    return createWordPopupFromRects(
      rect,
      horizontalRect,
      lookupCandidates,
      sourceParagraphIndex,
      triggerDefinitionText,
      triggerDefinitionText,
    );
  }, [createWordPopupFromRects]);

  const requestPopupDefinition = useCallback((popup: WordPopupState) => {
    const resources = resourcesRef.current;
    if (!resources) {
      throw new Error('Cannot load a popup definition before reader resources are available.');
    }
    void lookupFirstAvailableDefinition(resources.lexicon, popup.lookupCandidates)
      .then(async ({ candidate: resolvedCandidate, entry }) => {
        await waitForReaderScrollToSettle();
        setWordPopups((previous) => previous.map((popupCandidate) => (
          popupCandidate.id === popup.id ? {
            ...popupCandidate,
            target: createDefinitionTarget(resolvedCandidate.target.lemma, resolvedCandidate.target.partOfSpeech),
            lookupWord: normalizeToken(resolvedCandidate.lookupWord),
            contextStart: resolvedCandidate.selectionStart,
            contextEnd: resolvedCandidate.selectionEnd,
            originalContext: popupCandidate.contextIsBookParagraph ? {
              text: popupCandidate.contextText,
              start: resolvedCandidate.selectionStart,
              end: resolvedCandidate.selectionEnd,
            } : popupCandidate.originalContext,
            triggerSelection: popupCandidate.triggerSelection === null ? null : {
              definitionText: popupCandidate.triggerSelection.definitionText,
              end: resolvedCandidate.selectionEnd,
              start: resolvedCandidate.selectionStart,
            },
            definition: entry,
            definitionStatus: 'ready',
          } : popupCandidate
        )));
      })
      .catch(async (error: unknown) => {
        await waitForReaderScrollToSettle();
        console.error('popup-definition-load-failed', {
          lookupWord: popup.lookupWord,
          lemma: popup.target.lemma,
          error,
        });
        setWordPopups((previous) => previous.map((candidate) => (
          candidate.id === popup.id
            ? { ...candidate, definitionStatus: 'error' }
            : candidate
        )));
      });
  }, [waitForReaderScrollToSettle]);

  useLayoutEffect(() => {
    if (wordPopups.length === 0) {
      return;
    }

    const measuredPositions = wordPopups.map((popup, popupIndex) => {
      const popupElement = wordPopupRefs.current[popupIndex];
      if (!popupElement) {
        return { top: popup.top, left: popup.left };
      }
      const popupRect = popupElement.getBoundingClientRect();
      return calculateWordPopupPosition(
        popup.anchorRect,
        popup.horizontalAnchorRect,
        popupRect.width,
        popupRect.height,
        window.innerWidth,
        window.innerHeight,
      );
    });

    const positionChanged = measuredPositions.some((position, index) => (
      position.top !== wordPopups[index].top || position.left !== wordPopups[index].left
    ));
    if (!positionChanged) {
      return;
    }
    setWordPopups((previous) => previous.map((popup, index) => ({
      ...popup,
      top: measuredPositions[index]?.top ?? popup.top,
      left: measuredPositions[index]?.left ?? popup.left,
    })));
  }, [settings.englishVariant, settings.fontSize, settings.wsdMode, settings.wsdReductionLevel, settings.wsdContextUnit, settings.wsdContextSize, wordPopups]);

  const openRootWordPopup = useCallback((
    anchorRect: PopupAnchorRect,
    lookupCandidates: DefinitionLookupCandidate[],
    sourceParagraphIndex: number,
    contextText: string,
  ) => {
    const popup = createWordPopupFromRects(
      anchorRect,
      anchorRect,
      lookupCandidates,
      sourceParagraphIndex,
      null,
      contextText,
    );
    setWordPopups([popup]);
    requestPopupDefinition(popup);
  }, [createWordPopupFromRects, requestPopupDefinition]);

  const resolveDefinitionWordTarget = useCallback((click: DefinitionWordClick): DefinitionTarget => {
    const resources = resourcesRef.current;
    if (!resources) {
      throw new Error('Cannot analyze a definition word before reader resources are loaded.');
    }
    const profileState = loadProfileState();
    const profile = getActiveProfile(profileState);
    const analysis = analyzeChapter({
      chapter: {
        title: '',
        paragraphs: [click.definitionText],
      },
      settings: settingsRef.current,
      model: resources.model,
      profile,
      lemmaDict: resources.lemmaDict,
      nlp: resources.nlp,
      maxCardsPerParagraph: 1,
      includeCards: false,
    })[0];
    const token = analysis?.tokens.find((candidate) => (
      candidate.start === click.start && candidate.end === click.end
    ));
    if (token && token.lemma.length > 0) {
      return createDefinitionTarget(token.lemma, token.partOfSpeech);
    }
    return createDefinitionTarget(
      click.definitionText.slice(click.start, click.end),
      null,
    );
  }, []);

  const openDefinitionWordPopup = useCallback((
    parentPopupIndex: number | null,
    click: DefinitionWordClick,
    sourceParagraphIndex: number,
    originalContext: WsdContext | null,
  ) => {
    const target = resolveDefinitionWordTarget(click);
    const lookupCandidates = buildDefinitionLookupCandidates(
      click.definitionText,
      click.start,
      click.end,
      target,
    );
    const createdPopup = createWordPopupFromElement(
      click.element,
      lookupCandidates,
      sourceParagraphIndex,
      click.definitionText,
    );
    const parent = parentPopupIndex === null ? null : wordPopups[parentPopupIndex];
    if (parentPopupIndex !== null && !parent) {
      throw new RangeError(`Missing parent word popup: index=${parentPopupIndex}`);
    }
    if (!parent && originalContext === null) {
      throw new Error(`Missing original passage for definition lookup: word=${target.lemma} paragraph=${sourceParagraphIndex}`);
    }
    const popup: WordPopupState = {
      ...createdPopup,
      originalContext: parent ? parent.originalContext : originalContext,
      parentContexts: parent && !parent.contextIsBookParagraph
        ? [parent.contextText, ...parent.parentContexts]
        : [],
    };
    setWordPopups((previous) => {
      const ancestors = parentPopupIndex === null
        ? []
        : previous.slice(0, parentPopupIndex + 1);
      return [...ancestors, popup];
    });
    requestPopupDefinition(popup);
  }, [createWordPopupFromElement, requestPopupDefinition, resolveDefinitionWordTarget, wordPopups]);

  const closeAllWordPopups = useCallback(() => {
    setWordPopups([]);
  }, []);

  const closeWordPopupAtIndex = useCallback((popupIndex: number) => {
    setWordPopups((previous) => previous.slice(0, popupIndex));
  }, []);

  useEffect(() => {
    if (wordPopups.length === 0) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target) {
        closeAllWordPopups();
        return;
      }
      const popupElement = target instanceof Element
        ? target.closest<HTMLElement>('[data-word-popup-index]')
        : null;
      if (popupElement) {
        const popupIndex = Number.parseInt(popupElement.dataset.wordPopupIndex ?? '', 10);
        if (Number.isInteger(popupIndex)) {
          setWordPopups((previous) => previous.slice(0, popupIndex + 1));
        }
        return;
      }
      const clickedTrigger = target instanceof Element ? target.closest('[data-word-popup-trigger="true"]') : null;
      if (clickedTrigger) {
        return;
      }
      closeAllWordPopups();
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeAllWordPopups();
      }
    };

    const handleViewportResize = () => {
      closeAllWordPopups();
    };

    const handleUserScroll = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-word-popup-index]')) {
        return;
      }
      closeAllWordPopups();
    };

    const handleScrollKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-word-popup-index]')) {
        return;
      }
      if (SCROLL_KEYS.has(event.key)) {
        closeAllWordPopups();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    document.addEventListener('keydown', handleScrollKey);
    window.addEventListener('wheel', handleUserScroll, { passive: true });
    window.addEventListener('touchmove', handleUserScroll, { passive: true });
    window.addEventListener('resize', handleViewportResize);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
      document.removeEventListener('keydown', handleScrollKey);
      window.removeEventListener('wheel', handleUserScroll);
      window.removeEventListener('touchmove', handleUserScroll);
      window.removeEventListener('resize', handleViewportResize);
    };
  }, [closeAllWordPopups, wordPopups.length]);

  useLayoutEffect(() => {
    const opening = instantChapterTransitionRef.current;
    if (!book || !opening) return;
    instantChapterTransitionRef.current = null;
    const chapter = book.chapters[clampChapterNumber(book, book.currentChapter) - 1];
    const visibleParagraphs = measureVisibleReaderParagraphs(paraRefs.current, chapter.paragraphs.length, window.innerHeight);
    const visibleCardsReady = visibleParagraphs.every((index) => {
      const analysis = opening.analyses.get(index);
      return analysis !== undefined && analysis.cardTargets.every((target) =>
        opening.readyCards.has(`${index}:${definitionTargetKey(target)}`));
    });
    if (!visibleCardsReady) beginReaderLoading(0);
  }, [book, beginReaderLoading]);

  useLayoutEffect(() => {
    if (previousReadingModeRef.current === settings.readingMode) return;
    previousReadingModeRef.current = settings.readingMode;
    if (settings.readingMode === 'page') pageModeWasRevealedRef.current = false;
    if (!initialReaderLoadPendingRef.current) return;
    initialViewportParagraphsRef.current = null;
    completedInitialAnalysisRef.current = new Set();
    setInitialAnalysisRevision((revision) => revision + 1);
  }, [settings.readingMode]);

  useLayoutEffect(() => {
    if (settings.readingMode !== 'page' || !pagination.isReady || !pagination.layout || !book) return;
    const currentBook = bookRef.current ?? book;
    const layout = pagination.layout;
    const savedPagePosition = currentBook.pagePosition;
    const exactSavedPage = savedPagePosition?.layoutKey === layout.signature
      && savedPagePosition.pageIndex < layout.pages.length
      ? savedPagePosition.pageIndex
      : null;
    const pageRefreshAnchor = pageRefreshAnchorRef.current;
    const anchor = pendingPageAnchorRef.current
      ?? pageRefreshAnchor?.location
      ?? pageAnchorLocationRef.current
      ?? currentBook.location
      ?? currentLocationRef.current
      ?? readerLocationFromLegacyProgress(currentBook, currentBook.currentChapter, currentBook.currentChapterProgress);
    const pageIndex = exactSavedPage ?? readerPageIndexForLocation(layout.pages, anchor) ?? 0;
    const page = layout.pages[pageIndex];
    if (!page) throw new Error(`Reader pagination produced no page: chapterIndex=${layout.chapterIndex}`);
    const finishedLocation = lastLinearReaderLocation(currentBook);
    const expectedLocation = readerLocationsEqual(page.endLocation, finishedLocation)
      ? finishedLocation
      : resolveReaderLocation(currentBook, page.startLocation);
    const shouldCommit = currentPageIndexRef.current !== pageIndex
      || currentBook.pagePosition?.layoutKey !== layout.signature
      || currentBook.pagePosition?.pageIndex !== pageIndex
      || !readerLocationsEqual(currentBook.location ?? currentLocationRef.current, expectedLocation);
    if (shouldCommit) {
      commitReaderPage(pageIndex, layout);
    } else {
      currentPageIndexRef.current = pageIndex;
      setCurrentPageIndex(pageIndex);
      pageAnchorLocationRef.current = page.startLocation;
      pendingPageAnchorRef.current = null;
    }
    if (pageRefreshAnchor
      && pagination.settledMeasurementRevision > pageRefreshAnchor.settledMeasurementRevision) {
      pageRefreshAnchorRef.current = null;
    }
  }, [book, commitReaderPage, pagination.isReady, pagination.layout, pagination.settledMeasurementRevision, settings.readingMode]);

  useLayoutEffect(() => {
    const root = readerRootRef.current;
    if (!root) return;
    const setInert = (element: HTMLElement, inert: boolean): void => {
      const savedState = paginationInertStateRef.current.get(element);
      if (inert) {
        if (!savedState) {
          paginationInertStateRef.current.set(element, {
            inert: element.inert,
            ariaHidden: element.getAttribute('aria-hidden'),
          });
        }
        element.inert = true;
        element.setAttribute('aria-hidden', 'true');
        return;
      }
      if (!savedState) return;
      element.inert = savedState.inert;
      if (savedState.ariaHidden === null) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', savedState.ariaHidden);
      paginationInertStateRef.current.delete(element);
    };
    const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-reader-block-index]'));
    if (settings.readingMode !== 'page') {
      setInert(root, false);
      rows.forEach((row) => {
        setInert(row, false);
        row.querySelectorAll<HTMLElement>('a, button, input, select, textarea, [tabindex], [contenteditable="true"], [data-definition-card="true"]')
          .forEach((element) => setInert(element, false));
      });
      return;
    }
    setInert(root, !pageModeReady);
    if (!pageModeReady) return;
    const viewport = pageViewportRef.current;
    if (!viewport) return;
    const outerRect = viewport.getBoundingClientRect();
    const readingRow = root.closest<HTMLElement>('[data-testid="reading-row"]');
    const rowRect = readingRow?.getBoundingClientRect() ?? outerRect;
    const viewportRect = {
      top: Math.max(outerRect.top, rowRect.top),
      bottom: Math.min(outerRect.bottom, rowRect.bottom),
    };
    const isOutsidePage = (element: HTMLElement): boolean => {
      const rect = element.getBoundingClientRect();
      return rect.bottom <= viewportRect.top || rect.top >= viewportRect.bottom;
    };
    const focusableSelector = 'a, button, input, select, textarea, [tabindex], [contenteditable="true"], [data-definition-card="true"]';
    rows.forEach((row) => {
      const fragmentTop = Number(row.dataset.readerPageFragmentTop);
      const fragmentBottom = Number(row.dataset.readerPageFragmentBottom);
      const hasVisibleFragment = Number.isFinite(fragmentTop)
        && Number.isFinite(fragmentBottom)
        && fragmentBottom > fragmentTop;
      const visibleFragmentTop = hasVisibleFragment ? rowRect.top + fragmentTop : 0;
      const visibleFragmentBottom = hasVisibleFragment ? rowRect.top + fragmentBottom : 0;
      const rowOutsidePage = !hasVisibleFragment
        || visibleFragmentBottom <= viewportRect.top
        || visibleFragmentTop >= viewportRect.bottom;
      setInert(row, rowOutsidePage);
      row.querySelectorAll<HTMLElement>(focusableSelector).forEach((element) => {
        const rect = element.getBoundingClientRect();
        const outsideFragment = rect.bottom <= visibleFragmentTop || rect.top >= visibleFragmentBottom;
        setInert(element, rowOutsidePage || outsideFragment || isOutsidePage(element));
      });
    });
  }, [chapterAnalysis, currentPageIndex, definitionsByLemma, failedDefinitionLemmas, loadingDefinitionLemmas, pageModeReady, pagination.layout, settings.readingMode]);

  useLayoutEffect(() => {
    if (!book || isLoading || !initialReaderLoadPendingRef.current) return;
    if (settings.readingMode === 'page') {
      if (!displayedPage) return;
      const current = initialViewportParagraphsRef.current;
      const sameScope = current !== null
        && current.length === displayedPageParagraphs.length
        && current.every((index, position) => index === displayedPageParagraphs[position]);
      if (!sameScope) {
        initialViewportParagraphsRef.current = displayedPageParagraphs;
        completedInitialAnalysisRef.current = new Set(displayedPageParagraphs.filter((index) =>
          initialAnalysisFailedRef.current || publishedAnalysisParagraphsRef.current.has(index)));
        setInitialAnalysisRevision((revision) => revision + 1);
      }
      if (!assistanceEnabledRef.current || displayedPageParagraphs.length === 0) {
        initialReaderLoadPendingRef.current = false;
        setInitialViewportReady(true);
      }
      return;
    }
    const paragraphCount = book.chapters[clampChapterNumber(book, book.currentChapter) - 1]?.paragraphs.length ?? 0;
    if (initialViewportParagraphsRef.current !== null) return;
    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const viewportParagraphs = measureVisibleReaderParagraphs(paraRefs.current, paragraphCount, window.innerHeight);
        if (viewportParagraphs.length === 0 && paragraphCount > 0) {
          viewportParagraphs.push(resolveAnalysisAnchorIndex(paragraphCount, book.currentChapterProgress));
        }
        initialViewportParagraphsRef.current = viewportParagraphs;
        completedInitialAnalysisRef.current = new Set(viewportParagraphs.filter((index) => initialAnalysisFailedRef.current || publishedAnalysisParagraphsRef.current.has(index)));
        if (!assistanceEnabledRef.current || viewportParagraphs.length === 0) {
          initialReaderLoadPendingRef.current = false;
          setInitialViewportReady(true);
          return;
        }
        setInitialAnalysisRevision((revision) => revision + 1);
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [book, isLoading, initialProgressRestored, resolveAnalysisAnchorIndex, settings.readingMode, displayedPage, displayedPageParagraphs]);

  useEffect(() => {
    const visibleParagraphs = settings.readingMode === 'page'
      ? displayedPageParagraphs
      : initialViewportParagraphsRef.current;
    if (!initialReaderLoadPendingRef.current || !book || isLoading || !assistanceEnabled) return;
    if (!visibleParagraphs || visibleParagraphs.some((index) => settings.readingMode === 'page'
      ? pageAnalysisCompleteRunId !== analysisRunIdRef.current
        && !publishedAnalysisParagraphsRef.current.has(index)
        && !initialAnalysisFailedRef.current
      : !completedInitialAnalysisRef.current.has(index))) {
      setInitialLoadingMessage('Choosing difficult words...');
      return;
    }
    if (settings.readingMode === 'scroll' && !areInitialReaderCardsReady(
      visibleParagraphs,
      completedInitialAnalysisRef.current,
      chapterAnalysis,
      new Set(definitionsByLemma.keys()),
      loadingDefinitionLemmas,
      failedDefinitionLemmas,
    )) {
      setInitialLoadingMessage('Fetching definitions...');
      return;
    }
    const openingPage = settings.readingMode === 'page' ? displayedPage : null;
    const openingCardKeys = openingPage ? new Set(openingPage.cardTargetKeys) : null;
    const openingCardsReady = settings.readingMode === 'scroll' || visibleParagraphs.every((index) => {
      if (settings.readingMode === 'page'
        ? pageAnalysisCompleteRunId !== analysisRunIdRef.current
          && !publishedAnalysisParagraphsRef.current.has(index)
          && !initialAnalysisFailedRef.current
        : !completedInitialAnalysisRef.current.has(index)) return false;
      const analysis = chapterAnalysis[index];
      if (!analysis) return false;
      return analysis.cardTargets.every((target) => {
        if (openingCardKeys && !openingCardKeys.has(readerTargetDomKey(target, index))) return true;
        const lemma = normalizeToken(target.lemma);
        return !loadingDefinitionLemmas.has(lemma)
          && (definitionsByLemma.has(lemma) || failedDefinitionLemmas.has(lemma));
      });
    });
    if (!openingCardsReady) {
      setInitialLoadingMessage('Fetching definitions...');
      return;
    }
    const visibleCardsReady = visibleParagraphs.every((index) =>
      chapterAnalysis[index].cardTargets.every((target) =>
        (openingCardKeys && !openingCardKeys.has(readerTargetDomKey(target, index)))
          || readyInitialCardsRef.current.has(`${index}:${definitionTargetKey(target)}`)));
    if (!visibleCardsReady) {
      setInitialLoadingMessage(settings.wsdMode === 'none' ? 'Fetching definitions...' : 'Performing WSD...');
      return;
    }
    if (!initialProgressRestored) return;
    if (settings.readingMode === 'page'
      && (openingPageMeasurementKey === null
        || pagination.measuredMeasurementKey !== openingPageMeasurementKey)) return;
    const viewportCheckFrame = window.requestAnimationFrame(() => {
      initialReaderLoadPendingRef.current = false;
      setInitialViewportReady(true);
    });
    return () => window.cancelAnimationFrame(viewportCheckFrame);
  }, [
    book,
    isLoading,
    assistanceEnabled,
    chapterAnalysis,
    initialAnalysisRevision,
    initialProgressRestored,
    definitionsByLemma,
    loadingDefinitionLemmas,
    failedDefinitionLemmas,
    activeAnalysisRunId,
    settings.wsdMode,
    settings.readingMode,
    openingPageMeasurementKey,
    pagination.measuredMeasurementKey,
    displayedPage,
    displayedPageParagraphs,
    pagination.settledMeasurementRevision,
  ]);

  const readerLoading = isLoading || (book !== null && !initialViewportReady);
  const addCurrentBookmark = useCallback((): void => {
    const currentBook = bookRef.current;
    if (!currentBook) return;
    const location = captureCurrentReaderLocation() ?? currentLocationRef.current;
    if (!location) return;
    const profileId = readerProfileIdRef.current;
    if (!profileId) throw new Error(`Cannot add a bookmark without a loaded profile for book=${currentBook.id}.`);
    const existingBookmarks = listReaderBookmarks(profileId, currentBook.id);
    setBookmarks(existingBookmarks);
    const duplicate = existingBookmarks.some((bookmark) => readerLocationsEqual(bookmark.location, location));
    if (duplicate) {
      setBookmarkFeedback('Already bookmarked');
      if (bookmarkFeedbackTimeoutRef.current !== null) window.clearTimeout(bookmarkFeedbackTimeoutRef.current);
      bookmarkFeedbackTimeoutRef.current = window.setTimeout(() => {
        setBookmarkFeedback('');
        bookmarkFeedbackTimeoutRef.current = null;
      }, 1800);
      return;
    }
    const bookmark = createReaderBookmark(
      profileId,
      currentBook.id,
      location,
      bookmarkLabelAtLocation(currentBook, location),
    );
    setBookmarks((previous) => [...previous, bookmark]);
    setBookmarkFeedback('Bookmark added');
    if (bookmarkFeedbackTimeoutRef.current !== null) window.clearTimeout(bookmarkFeedbackTimeoutRef.current);
    bookmarkFeedbackTimeoutRef.current = window.setTimeout(() => {
      setBookmarkFeedback('');
      bookmarkFeedbackTimeoutRef.current = null;
    }, 1800);
  }, [captureCurrentReaderLocation]);

  const removeReaderBookmark = useCallback((bookmarkId: string): void => {
    const currentBook = bookRef.current;
    const profileId = readerProfileIdRef.current;
    if (!currentBook || !profileId) return;
    deleteReaderBookmark(profileId, currentBook.id, bookmarkId);
    setBookmarks((previous) => previous.filter((bookmark) => bookmark.id !== bookmarkId));
  }, []);

  const renameBookmark = useCallback((bookmarkId: string, label: string): void => {
    const currentBook = bookRef.current;
    const profileId = readerProfileIdRef.current;
    if (!currentBook || !profileId) throw new Error('Cannot rename a bookmark without a loaded reader profile and book.');
    const renamedBookmark = renameReaderBookmark(profileId, currentBook.id, bookmarkId, label);
    setBookmarks((previous) => previous.map((bookmark) => bookmark.id === renamedBookmark.id ? renamedBookmark : bookmark));
  }, []);

  useEffect(() => {
    const isTextEntryTarget = (target: EventTarget | null): boolean => target instanceof HTMLElement
      && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    const handleReaderShortcuts = (event: KeyboardEvent): void => {
      if (isTextEntryTarget(event.target)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setNavigationSearchRequested(true);
        setNavigationOpen(true);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || readerSettingsOpen || navigationOpen || studyOpen || wordPopups.length > 0) return;
      if (settings.readingMode === 'page'
        && (event.key === 'ArrowLeft' || event.key === 'PageUp' || event.key === 'ArrowRight' || event.key === 'PageDown')) {
        event.preventDefault();
        navigatePage(event.key === 'ArrowLeft' || event.key === 'PageUp' ? -1 : 1);
      } else if (event.key.toLowerCase() === 'b') {
        event.preventDefault();
        addCurrentBookmark();
      } else if (event.key === '[') {
        event.preventDefault();
        void updateCurrentChapter(-1);
      } else if (event.key === ']') {
        event.preventDefault();
        void updateCurrentChapter(1);
      }
    };
    window.addEventListener('keydown', handleReaderShortcuts);
    return () => window.removeEventListener('keydown', handleReaderShortcuts);
  }, [addCurrentBookmark, navigationOpen, navigatePage, readerSettingsOpen, settings.readingMode, studyOpen, updateCurrentChapter, wordPopups.length]);

  useEffect(() => {
    if (!book || isLoading || !initialViewportReady) return;
    const frame = window.requestAnimationFrame(() => persistCurrentChapterProgress(true));
    return () => window.cancelAnimationFrame(frame);
  }, [book?.id, book?.currentChapter, initialViewportReady, isLoading, persistCurrentChapterProgress]);

  useEffect(() => {
    const root = readerRootRef.current;
    if (!root || !book || !initialViewportReady || settings.readingMode === 'page') return;
    const scheduleAnchorRestore = (): void => {
      if (!canonicalAnchorCapturedRef.current) return;
      if (layoutRestoreTimeoutRef.current !== null) window.clearTimeout(layoutRestoreTimeoutRef.current);
      layoutRestoreTimeoutRef.current = window.setTimeout(() => {
        const elapsedSinceManualScroll = performance.now() - lastScrollActivityAtRef.current;
        if (elapsedSinceManualScroll < 300) {
          scheduleAnchorRestore();
          return;
        }
        const anchor = lastStableLocationRef.current;
        if (anchor && readerRootRef.current) restoreReaderLocation(readerRootRef.current, anchor, 72);
        layoutRestoreTimeoutRef.current = null;
      }, 180);
    };
    const observer = new ResizeObserver(scheduleAnchorRestore);
    observer.observe(root);
    return () => {
      observer.disconnect();
      if (layoutRestoreTimeoutRef.current !== null) {
        window.clearTimeout(layoutRestoreTimeoutRef.current);
        layoutRestoreTimeoutRef.current = null;
      }
    };
  }, [book?.id, book?.currentChapter, initialViewportReady, settings.readingMode]);

  useLayoutEffect(() => {
    if (!book || !initialViewportReady) return;
    const nextLayoutKey = JSON.stringify([
      settings.fontChoice,
      settings.fontSize,
      settings.lineSpacing,
      settings.pageWidth,
      assistanceEnabled,
    ]);
    if (previousLayoutKeyRef.current === nextLayoutKey) return;
    previousLayoutKeyRef.current = nextLayoutKey;
    if (settings.readingMode === 'page') return;
    if (!canonicalAnchorCapturedRef.current) return;
    const anchor = lastStableLocationRef.current;
    if (!anchor) return;
    const frame = window.requestAnimationFrame(() => {
      if (performance.now() - lastScrollActivityAtRef.current < 300) return;
      if (readerRootRef.current) restoreReaderLocation(readerRootRef.current, anchor, 72);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [assistanceEnabled, book?.id, book?.currentChapter, initialViewportReady, settings.fontChoice, settings.fontSize, settings.lineSpacing, settings.pageWidth, settings.readingMode]);

  useLayoutEffect(() => {
    if (!readerLoading && settings.readingMode !== 'page') return;
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    const previousScrollbarGutter = root.style.scrollbarGutter;
    root.style.scrollbarGutter = settings.readingMode === 'page' ? 'auto' : 'stable';
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = previousOverflow;
      root.style.scrollbarGutter = previousScrollbarGutter;
    };
  }, [readerLoading, settings.readingMode]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
        <span role="status" aria-live="polite">Loading reader...</span>
      </div>
    );
  }

  if (!book) {
    return <div className="min-h-screen bg-background text-foreground p-6">No books found in your library.</div>;
  }
  const pageLayout = pagination.layout?.layoutKey === paginationLayoutKey
    && pagination.layout.chapterIndex === paginationChapterIndex
    ? pagination.layout
    : null;
  const activePage = pageLayout?.pages[currentPageIndex];
  const pageHasOversizedSegment = activePage?.issues.length ? activePage.issues.length > 0 : false;
  const activePageTextHeight = activePage ? activePage.textClipHeight : 0;
  const activePagePresentationHeight = activePage && pageHasOversizedSegment
    ? Math.max(paginationPageHeight, activePage.presentationHeight)
    : paginationPageHeight;
  const currentChapterNumber = clampChapterNumber(book, book.currentChapter);
  const currentChapter = book.chapters[currentChapterNumber - 1];
  const chapterParagraphs = currentChapter?.paragraphs ?? [];
  const chapterDisplayTitle = currentChapter ? chapterTitleForReader(currentChapter, currentChapterNumber) : null;
  const profileStateForRender = loadProfileState();
  const activeProfileForRender = getActiveProfile(profileStateForRender);
  const observationLabels = activeProfileForRender.observations;
  const currentChapterNumberForPrerender = clampChapterNumber(book, book.currentChapter);
  const adjacentChapterNumbers = [
    adjacentReadingChapter(book.chapters, currentChapterNumberForPrerender, -1),
    adjacentReadingChapter(book.chapters, currentChapterNumberForPrerender, 1),
  ];
  const prerenderEntries = initialViewportReady && settings.readingMode === 'page'
    ? [...new Set(adjacentChapterNumbers)]
      .filter((chapterNumber) => chapterNumber !== currentChapterNumberForPrerender)
      .flatMap((chapterNumber) => {
        const chapterIndex = chapterNumber - 1;
        const entry = preparedChapterOpeningsRef.current.get(chapterIndex);
        if (!entry || entry.bookId !== book.id || entry.bookUpdatedAt !== book.updatedAt
          || entry.layoutKey !== readerPaginationLayoutKey(
            book,
            readerProfileIdRef.current,
            paginationProfileKey,
            chapterIndex,
            viewportSize.width,
            viewportSize.height,
            paginationPageHeight,
            settings,
            assistanceEnabled,
          )
          || !entry.analysisComplete || !entry.cardPreloadComplete || entry.previewError !== null) return [];
        if (entry.layout?.layoutKey === entry.layoutKey
          && entry.layout.chapterIndex === entry.chapterIndex
          && entry.layout.pageHeight === paginationPageHeight
          && entry.layout.pages.length > 0) return [];
        return [entry];
      })
    : [];
  const chapterReaderBlocks = readerBlocksForChapter(chapterParagraphs, currentChapter?.readerBlocks);
  const activePageCardGroups = new Map(pageModeReady
    ? activePage?.cardGroups.map((group) => [group.blockIndex, group]) ?? []
    : []);
  const activePageBlockOffsets = new Map(activePage?.blockDisplayOffsets.map((entry) => [entry.blockIndex, entry.offset]) ?? []);
  const activePageBlockFragments = new Map(activePage?.blockFragments.map((fragment) => [fragment.blockIndex, fragment]) ?? []);
  const readerBlockPresentation = (blockIndex: number): {
    offset: number;
    fragmentTop: number | undefined;
    fragmentBottom: number | undefined;
    clipPath: string | undefined;
    visibility: CSSProperties['visibility'];
  } => {
    const fragment = activePageBlockFragments.get(blockIndex);
    const offset = activePageBlockOffsets.get(blockIndex) ?? 0;
    if (settings.readingMode !== 'page') {
      return { offset: 0, fragmentTop: undefined, fragmentBottom: undefined, clipPath: undefined, visibility: undefined };
    }
    if (!activePage || !fragment) {
      return { offset, fragmentTop: undefined, fragmentBottom: undefined, clipPath: undefined, visibility: activePage ? 'hidden' : undefined };
    }
    const topInset = Math.max(0, fragment.startY - fragment.blockTopY);
    const bottomInset = Math.max(0, fragment.blockBottomY - fragment.endY);
    return {
      offset,
      fragmentTop: fragment.startY - activePage.startY + offset,
      fragmentBottom: fragment.endY - activePage.startY + offset,
      clipPath: `inset(${topInset}px 0 ${bottomInset}px 0)`,
      visibility: 'visible',
    };
  };
  const renderDefinitionCard = (
    sourceChapter: BookChapter | undefined,
    sourceParagraphs: readonly string[],
    preparedOpening: PreparedChapterOpening | null,
    sourceIndex: number,
    analysis: ParagraphAnalysis,
    target: DefinitionTarget,
    active: boolean,
    onReadinessChange: PreparedCardReadinessChange,
  ): ReactNode => {
    return (
      <ReaderDefinitionCardTarget
        key={readerTargetDomKey(target, sourceIndex)}
        sourceChapter={sourceChapter}
        sourceParagraphs={sourceParagraphs}
        preparedOpening={preparedOpening}
        sourceIndex={sourceIndex}
        analysis={analysis}
        target={target}
        active={active}
        definitionsByLemma={definitionsByLemma}
        loadingDefinitionLemmas={loadingDefinitionLemmas}
        failedDefinitionLemmas={failedDefinitionLemmas}
        observationLabels={observationLabels}
        settings={settings}
        activeDefinitionSelection={wordPopups[0]?.triggerSelection ?? undefined}
        onReadinessChange={onReadinessChange}
        onDefinitionWordClick={(click) => openDefinitionWordPopup(null, click, sourceIndex, contextForCard(analysis, target))}
        onMarkKnown={() => markLemma(target.lemma, true, sourceIndex)}
        onMarkUnknown={() => markLemma(target.lemma, false, sourceIndex)}
        getPriorityTarget={getParagraphElement}
      />
    );
  };
  const canGoToPreviousChapter = adjacentReadingChapter(book.chapters, currentChapterNumber, -1) !== currentChapterNumber;
  const canGoToNextChapter = adjacentReadingChapter(book.chapters, currentChapterNumber, 1) !== currentChapterNumber;
  const openChapterStudy = (): void => {
    if (!currentChapter || chapterParagraphs.length === 0 || !resourcesRef.current) {
      return;
    }
    persistCurrentChapterProgress(true);
    const visibleParagraphCount = Math.max(1, chapterParagraphs.length);
    const visibleAnchorIndex = resolveAnalysisAnchorIndex(
      visibleParagraphCount,
      calculateScrollProgressFromDocument(),
    );
    const sourceAnchorIndex = clampParagraphIndex(
      visibleAnchorIndex,
      chapterParagraphs.length,
    );
    setStudyScope({
      id: `${book.id}:chapter:${currentChapterNumber - 1}`,
      sourceDocumentId: book.id,
      chapterIndex: currentChapterNumber - 1,
      paragraphs: [...chapterParagraphs],
      paragraphOffset: 0,
      unreadParagraphIndex: sourceAnchorIndex,
    });
    setStudyOpen(true);
  };

  return (
    <>
    <div
      className="min-h-screen bg-background text-foreground"
      style={{
        ...(settings.readingMode === 'page' ? { touchAction: 'pan-y' } : {}),
        ...(!initialViewportReady && settings.readingMode === 'scroll' ? { visibility: 'hidden' as const } : {}),
      }}
      onPointerDown={handlePagePointerDown}
      onPointerMove={handlePagePointerMove}
      onPointerUp={handlePagePointerUp}
      onPointerCancel={handlePagePointerCancel}
      onClickCapture={handlePageScreenClick}
    >
      {readerSettingsOpen && (
        <div
          className="fixed inset-0 z-10 bg-black/20"
          aria-hidden="true"
          onClick={() => setReaderSettingsOpen(false)}
        />
      )}
      <header className={cn(
        'fixed top-0 inset-x-0 z-20 bg-background/95 backdrop-blur-sm border-b border-border transition-transform duration-300',
        fullscreenPageMode
          ? fullscreenToolbarOpen ? 'translate-y-0 z-30 pointer-events-none' : '-translate-y-full pointer-events-none'
          : settings.readingMode === 'page' || headerVisible ? 'translate-y-0' : '-translate-y-full'
      )}>
        <div className={cn(
          'container mx-auto px-4 h-14 flex items-center justify-between [&_button]:cursor-pointer [&_a]:cursor-pointer',
          fullscreenPageMode && fullscreenToolbarOpen && 'pointer-events-none [&_button]:pointer-events-auto [&_a]:pointer-events-auto',
        )}>
          <div className="flex items-center gap-0 sm:gap-1">
            <Link href="/">
              <Button
                variant="ghost"
                size="sm"
                className="gap-2 text-muted-foreground hover:text-foreground"
                aria-label="Back to library"
                data-testid="button-back-library"
                onClick={() => persistCurrentChapterProgress(true)}
              >
                <ChevronLeft size={18} /><span className="hidden sm:inline">Library</span>
              </Button>
            </Link>
          </div>
          <div className="min-w-0 max-w-[24vw] truncate text-center font-serif text-sm font-medium text-muted-foreground hidden md:block">
            {book.title} — {chapterDisplayTitle ?? `Chapter ${currentChapterNumber}`} · {Math.round(readingProgressPercent)}%
          </div>
          <div className="flex items-center gap-0 sm:gap-1">
            {settings.readingMode === 'page' && (
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground"
                aria-label={fullscreenPageMode ? 'Exit fullscreen reader' : 'Enter fullscreen reader'}
                data-testid="button-reader-fullscreen"
                onClick={() => {
                  updateSetting('fullscreenPageMode', !settings.fullscreenPageMode);
                  setFullscreenToolbarOpen(false);
                }}
              >
                {fullscreenPageMode ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
              </Button>
            )}
            <Button variant="ghost" size="icon" className="text-muted-foreground" aria-label="Add bookmark at current position"
              onClick={addCurrentBookmark} data-testid="button-add-bookmark">
              <BookmarkPlus size={18} />
            </Button>
            <Button variant="ghost" size="icon" className="text-muted-foreground" aria-label="Open book contents, bookmarks, and search"
              onClick={() => { setNavigationSearchRequested(false); setNavigationOpen(true); }} data-testid="button-reader-navigation">
              <List size={18} />
            </Button>
            {returnLocation && (
              <Button variant="ghost" size="icon" className="hidden text-muted-foreground sm:inline-flex" aria-label="Return to previous position"
                onClick={returnToPreviousPosition} data-testid="button-reader-return">
                <CornerUpLeft size={18} />
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-muted-foreground hover:text-foreground"
              aria-label="Study this chapter"
              onClick={openChapterStudy}
              disabled={!currentChapter || chapterParagraphs.length === 0 || !resourcesRef.current}
              data-testid="button-study-chapter"
            >
              <GraduationCap size={18} />
              <span className="hidden sm:inline">Study</span>
            </Button>
            <Button variant="ghost" size="icon"
              onClick={() => setAssistanceEnabled(!assistanceEnabled)}
              className={cn('text-muted-foreground transition-colors', assistanceEnabled && 'text-primary bg-primary/10')}
              aria-label="Toggle vocabulary assistance" data-testid="button-toggle-assistance">
              {assistanceEnabled ? <Eye size={18} /> : <EyeOff size={18} />}
            </Button>
            <Sheet modal={false} open={readerSettingsOpen} onOpenChange={setReaderSettingsOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="text-muted-foreground" aria-label="Reader settings" data-testid="button-reader-settings">
                  <Type size={18} />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" disableAnimation className="w-[300px] sm:w-[400px] overflow-y-auto">
                <SheetHeader className="mb-6">
                  <SheetTitle className="font-serif">Reader Settings</SheetTitle>
                </SheetHeader>
                <div className="space-y-8">
                  <div className="space-y-4">
                    <Label className="text-base font-medium">Reading Mode</Label>
                    <div className="grid grid-cols-2 gap-3">
                      <Button
                        variant={settings.readingMode === 'scroll' ? 'default' : 'outline'}
                        onClick={() => switchReadingMode('scroll')}
                        data-testid="reading-mode-scroll"
                      >Scroll</Button>
                      <Button
                        variant={settings.readingMode === 'page' ? 'default' : 'outline'}
                        onClick={() => switchReadingMode('page')}
                        data-testid="reading-mode-page"
                      >Pages</Button>
                    </div>
                  </div>
                  <div className="space-y-4">
                    <Label className="text-base font-medium">Font Size</Label>
                    <div className="flex items-center gap-4">
                      <span className="text-sm">A</span>
                      <Slider value={[settings.fontSize]} min={12} max={32} step={1}
                        onValueChange={([value]) => updateSetting('fontSize', value)} className="flex-1" />
                      <span className="text-lg">A</span>
                    </div>
                  </div>
                  <div className="space-y-4">
                    <Label className="text-base font-medium">Font Family</Label>
                    <div className="grid grid-cols-2 gap-3">
                      {(['Serif', 'Sans'] as const).map((font) => (
                        <Button key={font} variant={settings.fontChoice === font ? 'default' : 'outline'}
                          className={cn('h-12', font === 'Serif' ? 'font-serif' : 'font-sans')}
                          onClick={() => updateSetting('fontChoice', font)} data-testid={`button-font-${font.toLowerCase()}`}>
                          {font}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-4">
                    <Label className="text-base font-medium">Line Spacing</Label>
                    <div className="grid grid-cols-3 gap-3">
                      {(['Compact', 'Normal', 'Relaxed'] as const).map((spacing) => (
                        <Button key={spacing} variant={settings.lineSpacing === spacing ? 'default' : 'outline'} size="sm"
                          onClick={() => updateSetting('lineSpacing', spacing)} data-testid={`button-spacing-${spacing.toLowerCase()}`}>
                          {spacing}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-4">
                    <Label className="text-base font-medium">Page Width</Label>
                    <div className="grid grid-cols-3 gap-3">
                      {(['Narrow', 'Normal', 'Wide'] as const).map((width) => (
                        <Button key={width} variant={settings.pageWidth === width ? 'default' : 'outline'} size="sm"
                          onClick={() => updateSetting('pageWidth', width)} data-testid={`button-width-${width.toLowerCase()}`}>
                          {width}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-4">
                    <Label className="text-base font-medium">Theme</Label>
                    <div className="grid grid-cols-3 gap-2">
                      {(['light', 'dark', 'system'] as const).map((themeChoice) => (
                        <Button key={themeChoice} variant={theme === themeChoice ? 'default' : 'outline'} size="sm"
                          onClick={() => setTheme(themeChoice)} data-testid={`button-theme-${themeChoice}`}>
                          {themeChoice[0].toUpperCase() + themeChoice.slice(1)}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              </SheetContent>
            </Sheet>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground" aria-label="More actions" data-testid="button-reader-more-actions">
                  <MoreHorizontal size={18} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => { markBookFinished(); }} data-testid="button-mark-book-finished">
                  Mark book finished
                </DropdownMenuItem>
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => { void deleteCurrentBook(); }}>
                  <Trash2 size={16} />
                  Delete Book
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <ReaderNavigationSheet
        open={navigationOpen}
        startOnSearch={navigationSearchRequested}
        onOpenChange={(open) => {
          setNavigationOpen(open);
          if (!open) setNavigationSearchRequested(false);
        }}
        book={book}
        location={currentLocation}
        bookmarks={bookmarks}
        onNavigate={(location) => navigateToReaderLocation(location, true)}
        onDeleteBookmark={removeReaderBookmark}
        onRenameBookmark={renameBookmark}
      />
      {bookmarkFeedback && <div role="status" aria-live="polite" className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-md bg-foreground px-4 py-2 text-sm text-background">{bookmarkFeedback}</div>}

      {settings.readingMode === 'scroll' && <div className="h-14" />}

      <main
        ref={pageViewportRef}
        className={cn(
          'mx-auto px-4 sm:px-6',
          getOuterWidthClass(),
          settings.readingMode === 'page' && cn(
            'reader-page-mode fixed left-0 right-0 z-10',
            fullscreenPageMode ? 'top-0 bottom-9' : 'top-[72px] bottom-16',
          ),
        )}
        style={settings.readingMode === 'page' ? {
          ...(fullscreenPageMode ? { top: `${fullscreenTopSpacing}px` } : {}),
          overflowX: 'clip',
          overflowY: 'auto',
          touchAction: 'pan-y',
        } : undefined}
        data-testid={settings.readingMode === 'page' ? 'reader-page-viewport' : undefined}
        data-page-index={pageModeReady ? currentPageIndex : undefined}
        data-page-count={pageModeReady ? pageLayout?.pages.length : undefined}
        data-page-start={pageModeReady ? activePage?.startY : undefined}
        data-page-end={pageModeReady ? activePage?.endY : undefined}
        onClick={() => {
          scrollDirectionRef.current = 0;
          lastScrollY.current = window.scrollY;
          setHeaderVisible(true);
        }}
      >
        <div
          className={cn(settings.readingMode === 'page' ? 'py-0' : 'py-12 md:py-20')}
          style={settings.readingMode === 'page' ? {
            height: `${activePagePresentationHeight}px`,
            overflow: 'clip',
            position: 'relative',
            '--reader-page-height': `${paginationPageHeight}px`,
            '--reader-page-card-height': `${Math.min(240, paginationPageHeight * 0.35)}px`,
          } as CSSProperties : undefined}
          data-testid="reading-row"
          data-reader-pagination-host=""
        >
          <div
            className={settings.readingMode === 'page' ? 'reader-page-text-clip' : 'contents'}
            style={settings.readingMode === 'page' ? {
              height: `${Math.max(1, activePage ? activePageTextHeight : paginationPageHeight)}px`,
              overflow: 'clip',
            } : undefined}
          >
          <div
            ref={readerRootRef}
            className={cn('relative flex-1 min-w-0 flex flex-col', settings.readingMode === 'page' && 'reader-page-content')}
            style={settings.readingMode === 'page' ? {
              transform: `translateY(${-(activePage?.startY ?? 0)}px)`,
              visibility: pageModeReady ? 'visible' : 'hidden',
            } as CSSProperties : undefined}
            data-testid="left-column"
          >
            {chapterDisplayTitle && <h1 className="text-3xl md:text-5xl font-medium mb-12 text-center text-foreground/90 font-serif">
              {chapterDisplayTitle}
            </h1>}

            <div
              className={cn(getTextFontClasses())}
              style={{ fontSize: `${settings.fontSize}px` }}
              data-testid="text-column"
              onClickCapture={(event: ReactMouseEvent<HTMLDivElement>) => {
                const link = event.target instanceof Element ? event.target.closest('a') : null;
                const href = link?.getAttribute('href');
                if (!href?.startsWith('#')) return;
                const anchor = href.slice(1);
                const targetChapter = readerAnchorChapter(book.chapters, anchor);
                event.preventDefault();
                event.stopPropagation();
                if (targetChapter === null) {
                  console.warn('reader-link-target-missing', { bookId: book.id, href });
                  return;
                }
                const targetElement = document.getElementById(anchor);
                const targetChapterContent = book.chapters[targetChapter - 1];
                const targetBlocks = targetChapterContent
                  ? readerBlocksForChapter(targetChapterContent.paragraphs, targetChapterContent.readerBlocks)
                  : [];
                const targetBlockIndex = targetBlocks.findIndex((block) => block.anchorIds?.includes(anchor));
                const rowBlockIndex = Number(targetElement?.closest<HTMLElement>('[data-reader-block-index]')?.dataset.readerBlockIndex);
                const blockIndex = targetChapter === currentChapterNumber && Number.isInteger(rowBlockIndex)
                  ? rowBlockIndex
                  : targetBlockIndex >= 0 ? targetBlockIndex : 0;
                const targetLocation = { chapterIndex: targetChapter - 1, blockIndex, textOffset: 0 };
                if (targetChapter === currentChapterNumber) {
                  navigateToReaderLocation(targetLocation, true);
                  if (settings.readingMode === 'scroll') {
                    window.requestAnimationFrame(() => targetElement?.scrollIntoView({ behavior: 'auto', block: 'start' }));
                  }
                  return;
                }
                navigateToReaderLocation(targetLocation, true);
                pendingReaderAnchorRef.current = anchor;
              }}
            >
              <ReaderChapterBlockList
                paragraphs={chapterParagraphs}
                blocks={chapterReaderBlocks}
                analyses={chapterAnalysis}
                assistanceEnabled={assistanceEnabled}
                pageMode={settings.readingMode === 'page'}
                pageHeight={paginationPageHeight}
                includeDocumentIds
                loadingImagesEager={settings.readingMode === 'page'}
                presentationForBlock={readerBlockPresentation}
                renderParagraphSupplement={(sourceIndex, analysis) => settings.readingMode === 'scroll'
                  && assistanceEnabled && analysis.cardTargets.length > 0
                  ? (
                    <div className="mt-3 flex flex-wrap items-start gap-3" data-testid={`mobile-card-group-${sourceIndex}`}>
                      {analysis.cardTargets.map((target) => renderDefinitionCard(
                        currentChapter,
                        chapterParagraphs,
                        activePreparedOpeningRef.current,
                        sourceIndex,
                        analysis,
                        target,
                        true,
                        recordInitialCardReadiness,
                      ))}
                    </div>
                  ) : null}
                onElementChange={setParagraphElement}
                onOpenWordPopup={openRootWordPopup}
              />
            </div>

            {settings.readingMode === 'scroll' && (
              <div className="mt-20 pt-8 border-t border-border flex justify-between items-center text-muted-foreground font-serif">
                <Button
                  variant="ghost"
                  className="gap-1 px-2 text-xs sm:gap-2 sm:px-4 sm:text-sm"
                  data-testid="button-prev-chapter"
                  disabled={!canGoToPreviousChapter}
                  onClick={() => void updateCurrentChapter(-1)}
                >
                  <ChevronLeft size={16} />
                  <span className="sm:hidden">Previous</span>
                  <span className="hidden sm:inline">Previous Chapter</span>
                </Button>
                <span className="text-xs sm:text-sm" data-testid="text-page-info">
                  Chapter {currentChapterNumber} of {book.chapters.length}
                </span>
                <Button
                  variant="ghost"
                  className="gap-1 px-2 text-xs sm:gap-2 sm:px-4 sm:text-sm"
                  data-testid="button-next-chapter"
                  disabled={!canGoToNextChapter}
                  onClick={() => void updateCurrentChapter(1)}
                >
                  <span className="sm:hidden">Next</span>
                  <span className="hidden sm:inline">Next Chapter</span>
                  <ChevronLeft size={16} className="rotate-180" />
                </Button>
              </div>
            )}
          </div>
          </div>

          {settings.readingMode === 'page' && assistanceEnabled && chapterReaderBlocks.map((block, blockIndex) => {
            if (block.type !== 'paragraph') return null;
            const sourceIndex = block.paragraphIndex;
            const analysis = chapterAnalysis[sourceIndex];
            if (!analysis || analysis.cardTargets.length === 0) return null;
            const group = activePageCardGroups.get(blockIndex);
            const groupIsActive = pageModeReady && group !== undefined;
            const activeKeys = new Set(group?.targetKeys ?? []);
            return (
              <div
                key={`page-card-group-${blockIndex}`}
                className={cn(
                  'absolute inset-x-0 flex flex-wrap items-start gap-3 px-1',
                  groupIsActive
                    ? 'reader-page-card-group z-10 bg-background/95'
                    : 'reader-page-card-measurements',
                )}
                style={{
                  top: `${group?.topOffset ?? 0}px`,
                  visibility: groupIsActive ? 'visible' : 'hidden',
                  pointerEvents: groupIsActive ? 'auto' : 'none',
                } as CSSProperties}
                aria-hidden={!groupIsActive}
                inert={!groupIsActive}
                data-testid={`reader-page-card-group-${blockIndex}`}
              >
                {analysis.cardTargets.map((target) => renderDefinitionCard(
                  currentChapter,
                  chapterParagraphs,
                  activePreparedOpeningRef.current,
                  sourceIndex,
                  analysis,
                  target,
                  groupIsActive && activeKeys.has(readerTargetDomKey(target, sourceIndex)),
                  recordInitialCardReadiness,
                ))}
              </div>
            );
          })}

        </div>
        {settings.readingMode === 'page' && !pageModeReady && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/95 p-6 text-center text-foreground">
            {paginationErrorMessage ? (
              <div role="alert" data-testid="reader-pagination-status" className="max-w-md space-y-4">
                <p>Pages could not be prepared: {paginationErrorMessage}</p>
                <Button variant="outline" onClick={() => switchReadingMode('scroll')}>
                  Switch to scroll mode
                </Button>
              </div>
            ) : (
              <span role="status" aria-live="polite" data-testid="reader-pagination-status">
                Preparing chapter pages…
              </span>
            )}
          </div>
        )}
      </main>
      {prerenderEntries.map((entry) => (
        <ReaderChapterPrerender
          key={`${entry.chapterIndex}:${entry.layoutKey}`}
          entry={entry}
          layoutKey={entry.layoutKey}
          pageHeight={paginationPageHeight}
          pageWidthClass={getOuterWidthClass()}
          textFontClass={getTextFontClasses()}
          settings={settings}
          assistanceEnabled={assistanceEnabled}
          definitionsByLemma={definitionsByLemma}
          loadingDefinitionLemmas={loadingDefinitionLemmas}
          failedDefinitionLemmas={failedDefinitionLemmas}
          observationLabels={observationLabels}
          onLayoutReady={recordPrerenderLayout}
          onError={recordPrerenderError}
        />
      ))}
      {settings.readingMode === 'page' && (
        <footer className={cn(
          'fixed inset-x-0 bottom-0 z-20',
          fullscreenPageMode ? 'h-9' : 'h-16 border-t border-border bg-background/95 backdrop-blur-sm',
        )}>
          <div className={cn(
            'mx-auto flex h-full items-center px-4 sm:px-6',
            getOuterWidthClass(),
            fullscreenPageMode ? 'justify-center pointer-events-none' : 'justify-between',
          )}>
            {!fullscreenPageMode && <>
            <Button
              variant="ghost"
              className="gap-1 px-2 text-xs sm:gap-2 sm:px-4 sm:text-sm"
              aria-label="Previous page"
              data-testid="button-prev-page"
              disabled={currentPageIndex === 0 && !canGoToPreviousChapter}
              onClick={() => navigatePage(-1)}
            >
              <ChevronLeft size={16} />
              <span>Previous</span>
            </Button>
            <span className="text-center text-xs text-muted-foreground sm:text-sm" data-testid="text-page-info">
              {pageModeReady && pageLayout
                ? `Chapter ${currentChapterNumber} · Page ${currentPageIndex + 1} of ${pageLayout.pages.length}`
                : `Chapter ${currentChapterNumber} · Preparing pages`}
            </span>
            <Button
              variant="ghost"
              className="gap-1 px-2 text-xs sm:gap-2 sm:px-4 sm:text-sm"
              aria-label="Next page"
              data-testid="button-next-page"
              disabled={currentPageIndex >= (pageLayout?.pages.length ?? 1) - 1 && !canGoToNextChapter}
              onClick={() => navigatePage(1)}
            >
              <span>Next</span>
              <ChevronLeft size={16} className="rotate-180" />
            </Button>
            </>}
            {fullscreenPageMode && (
              <span className="rounded-full bg-background/75 px-3 py-1 text-center text-[11px] text-muted-foreground backdrop-blur-sm" data-testid="text-page-info">
                {pageModeReady && pageLayout
                  ? `Ch. ${currentChapterNumber} · ${currentPageIndex + 1}/${pageLayout.pages.length}`
                  : `Ch. ${currentChapterNumber} · Preparing`}
              </span>
            )}
          </div>
        </footer>
      )}
      {activeAnalysisRunId !== null && (
        <div className={cn(
          'pointer-events-none fixed right-4 z-30 text-muted-foreground',
          settings.readingMode === 'page' && !fullscreenPageMode ? 'bottom-20' : 'bottom-4',
        )}>
          <ReaderActivityIndicator
            ariaLabel="Analyzing text"
            testId="reader-analysis-indicator"
          />
        </div>
      )}
      {wordPopups.map((popup, popupIndex) => {
        const indicatorPosition = calculateWordLookupIndicatorPosition(
          popup.anchorRect,
          window.innerWidth,
          window.innerHeight,
        );
        const pendingIndicator = (
          <div
            key={popup.id}
            className="pointer-events-none fixed text-muted-foreground"
            style={{
              top: indicatorPosition.top,
              left: indicatorPosition.left,
              zIndex: 40 + popupIndex,
            }}
          >
            <ReaderActivityIndicator
              ariaLabel={`Looking up definition for ${popup.lookupWord || popup.target.lemma}`}
              testId={popupIndex === 0
                ? 'reader-definition-lookup-indicator'
                : `reader-definition-lookup-indicator-${popupIndex}`}
            />
          </div>
        );
        if (popup.definitionStatus === 'loading') {
          return pendingIndicator;
        }
        const rawDefinition = popup.definition
          ?? createFallbackLexiconEntry(popup.lookupWord || popup.target.lemma);
        const definition = resolveLexiconEntry(rawDefinition, popup.target);
        const observation = observationLabels[popup.target.lemma];
        const originalContext = popup.contextIsBookParagraph || popup.originalContext === null ? null
          : settings.wsdContextUnit === 'sentence'
            ? sentenceWindowForWsd(chapterParagraphs, popup.sourceParagraphIndex, popup.originalContext, settings.wsdContextSize)
            : paragraphWindowForWsd(chapterParagraphs, popup.sourceParagraphIndex, popup.originalContext, settings.wsdContextSize);
        const outerContexts = popup.contextIsBookParagraph ? undefined
          : [...popup.parentContexts, ...(originalContext === null ? [] : [originalContext.text])];
        return (
          <div
            key={popup.id}
            className="fixed"
            style={{ top: popup.top, left: popup.left, zIndex: 40 + popupIndex }}
            ref={(element) => {
              wordPopupRefs.current[popupIndex] = element;
            }}
            data-word-popup-index={popupIndex}
            data-testid={popupIndex === 0 ? 'word-definition-popup' : `word-definition-popup-${popupIndex}`}
          >
            <ContextualDefinitionCard
              definition={definition}
              context={{ text: popup.contextText, start: popup.contextStart, end: popup.contextEnd }}
              outerContexts={outerContexts}
              contextParagraphs={popup.contextIsBookParagraph ? chapterParagraphs : [popup.contextText]}
              contextParagraphIndex={popup.contextIsBookParagraph ? popup.sourceParagraphIndex : 0}
              wsdMode={settings.wsdMode}
              wsdPriority="popup"
              wsdMargin={settings.wsdMode === 'none' ? 0 : marginForReductionLevel(settings.wsdReductionLevel, settings.wsdMode)}
              wsdContextUnit={settings.wsdContextUnit}
              wsdContextSize={settings.wsdContextSize}
              pendingIndicator={pendingIndicator}
              onWsdSettled={() => setWordPopups((previous) => previous.slice())}
              activeDefinitionSelection={wordPopups[popupIndex + 1]?.triggerSelection ?? undefined}
              fontSize={settings.fontSize}
              definitionStatus={popup.definitionStatus}
              onDefinitionWordClick={(click) => {
                openDefinitionWordPopup(popupIndex, click, popup.sourceParagraphIndex, null);
              }}
              onMarkKnown={() => {
                markLemma(popup.target.lemma, true, popup.sourceParagraphIndex);
                closeWordPopupAtIndex(popupIndex);
              }}
              onMarkUnknown={() => {
                markLemma(popup.target.lemma, false, popup.sourceParagraphIndex);
                closeWordPopupAtIndex(popupIndex);
              }}
              isMarkedKnown={observation === 1}
              isMarkedUnknown={observation === 0}
              pronunciationVariant={settings.englishVariant}
              compact
            />
          </div>
        );
      })}
      {studyOpen && studyScope && resourcesRef.current && (
        <StudyFlow
          open={studyOpen}
          onOpenChange={setStudyOpen}
          bookTitle={book.title}
          profileId={activeProfileForRender.id}
          scope={studyScope}
          settings={settings}
          model={resourcesRef.current.model}
          lemmaDict={resourcesRef.current.lemmaDict}
          lexicon={resourcesRef.current.lexicon}
          nlp={resourcesRef.current.nlp}
          onMarkWord={markLemma}
        />
      )}
    </div>
    <ReaderVocabularyTestOnboarding readerReady={initialViewportReady} />
    {!initialViewportReady && settings.readingMode === 'scroll' && (
      <div
        className="fixed inset-0 z-[100] flex min-h-screen items-center justify-center overscroll-none bg-background p-6 text-foreground"
        onWheel={(event) => event.preventDefault()}
        onTouchMove={(event) => event.preventDefault()}
      >
        <span role="status" aria-live="polite">{initialLoadingMessage}</span>
      </div>
    )}
    </>
  );
}
