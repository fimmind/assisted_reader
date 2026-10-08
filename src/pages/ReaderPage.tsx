import {
  createElement, memo, useState, useEffect, useRef, useLayoutEffect, useCallback,
} from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { useParams, Link, useLocation } from 'wouter';
import { ChevronLeft, Type, Eye, EyeOff, GraduationCap, MoreHorizontal, Trash2 } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useSettings } from '@/hooks/useSettings';
import { ContextualDefinitionCard } from '@/components/ContextualDefinitionCard';
import { StudyFlow } from '@/components/StudyFlow';
import type { DefinitionTextSelection, DefinitionWordClick } from '@/components/WordDefinitionCard';
import { marginForReductionLevel } from '@/core/wsd-filter';
import type { WsdContext } from '@/core/wsd-filter';
import { startWsdModel, stopWsdModel } from '@/core/wsd-runtime';
import { cn } from '@/lib/utils';
import { deleteBookById, getBookById, listBooks, upsertBook } from '@/core/books-store';
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
import { analyzeChapter, createCachedChapterAnalyzer, createLexicalAnalysisCache, rankParagraphCardTargets } from '@/core/reader-analysis';
import { getActiveProfile, listenStateUpdated, loadProfileState, upsertObservation } from '@/core/profile-store';
import type { LazyLexicon } from '@/core/lexicon';
import type { DefinitionLookupCandidate } from '@/core/definition-target';
import type { ChapterAnalyzer, LexicalAnalysisCache } from '@/core/reader-analysis';
import type { StudyTextScope } from '@/core/study';
import type {
  DefinitionTarget,
  ImportedBook,
  LexiconEntry,
  ParagraphAnalysis,
  PartOfSpeech,
  ReaderInlineMark,
  ReaderParagraphBlock,
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

type NlpLike = ((text: string) => {
  terms: () => {
    json: () => Array<{ text?: string; normal?: string; tags?: string[]; terms?: Array<{ text?: string; normal?: string; tags?: string[] }> }>;
  };
  verbs: () => { toInfinitive: () => { out: (format: 'text') => string } };
  nouns: () => { toSingular: () => { out: (format: 'text') => string } };
  adjectives: () => { conjugate: () => Array<Record<string, string>> };
}) | null;

interface ReaderResources {
  model: VocabularyModel;
  lemmaDict: Record<string, string>;
  lexicon: LazyLexicon;
  nlp: NlpLike;
  lexicalAnalysisCache: LexicalAnalysisCache;
}

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
}

type DefinitionLoadStatus = 'loading' | 'ready' | 'error';

interface PopupAnchorRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface ReaderActivityIndicatorProps {
  ariaLabel: string;
  testId: string;
}

interface ReaderParagraphTextProps {
  analysis: ParagraphAnalysis;
  block: ReaderParagraphBlock;
  assistanceEnabled: boolean;
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

type AnalysisRefreshMode = 'reset' | 'preserve';

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
          loading="lazy"
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
      {block.anchorIds?.map((anchorId) => <span key={anchorId} id={anchorId} className="reader-anchor" />)}
      {createElement(
        blockTag,
        {
          ref: (element: HTMLElement | null) => onElementChange(visibleParagraphIndex, element),
          className: blockClass,
          style: blockStyle,
          'data-testid': `paragraph-${visibleParagraphIndex}`,
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

export default function ReaderPage() {
  const { bookId } = useParams();
  const [, setLocation] = useLocation();
  const { settings, updateSetting } = useSettings();

  const [book, setBook] = useState<ImportedBook | null>(null);
  const [assistanceEnabled, setAssistanceEnabled] = useState(true);
  const [headerVisible, setHeaderVisible] = useState(true);
  const [readerSettingsOpen, setReaderSettingsOpen] = useState(false);
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
  const resourcesRef = useRef<ReaderResources | null>(null);
  const bookRef = useRef<ImportedBook | null>(null);
  const chapterAnalysisRef = useRef<ParagraphAnalysis[]>([]);
  const definitionsByLemmaRef = useRef<Map<string, LexiconEntry>>(new Map());
  const automaticDefinitionRequestsRef = useRef<Map<string, Promise<void>>>(new Map());
  const nextWordPopupIdRef = useRef(1);
  const settingsRef = useRef<ReaderSettings>(settings);
  const assistanceEnabledRef = useRef<boolean>(assistanceEnabled);
  const analysisRunIdRef = useRef(0);
  const deferredAnalysisHandleRef = useRef<DeferredHandle | null>(null);
  const progressPersistTimeoutRef = useRef<number | null>(null);
  const delayedRestoreTimeoutRef = useRef<number | null>(null);
  const isRestoringProgressRef = useRef(false);
  const lastPersistedChapterProgressRef = useRef(0);
  const initialReaderLoadPendingRef = useRef(false);
  const initialViewportParagraphsRef = useRef<number[] | null>(null);
  const completedInitialAnalysisRef = useRef<Set<number>>(new Set());
  const publishedAnalysisParagraphsRef = useRef<Set<number>>(new Set());
  const initialAnalysisFailedRef = useRef(false);
  const readyInitialCardsRef = useRef<Set<string>>(new Set());

  const beginReaderLoading = useCallback((): void => {
    analysisRunIdRef.current += 1;
    clearDeferredHandle(deferredAnalysisHandleRef.current);
    deferredAnalysisHandleRef.current = null;
    if (delayedRestoreTimeoutRef.current !== null) {
      window.clearTimeout(delayedRestoreTimeoutRef.current);
      delayedRestoreTimeoutRef.current = null;
    }
    initialReaderLoadPendingRef.current = true;
    initialViewportParagraphsRef.current = null;
    completedInitialAnalysisRef.current = new Set();
    publishedAnalysisParagraphsRef.current = new Set();
    initialAnalysisFailedRef.current = false;
    readyInitialCardsRef.current = new Set();
    setInitialViewportReady(false);
    setInitialLoadingMessage('Loading reader...');
    setInitialProgressRestored(false);
  }, []);

  const openReaderChapter = useCallback((nextBook: ImportedBook): void => {
    beginReaderLoading();
    setChapterAnalysis(buildPlainChapterAnalysis(nextBook));
    setBook(nextBook);
  }, [beginReaderLoading]);

  const recordInitialCardReadiness = useCallback((paragraphIndex: number, targetKey: string, ready: boolean): void => {
    if (!initialReaderLoadPendingRef.current) return;
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
    paraRefs.current[visibleParagraphIndex] ?? null
  ), []);

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
    const currentRunId = analysisRunIdRef.current + 1;
    analysisRunIdRef.current = currentRunId;
    const expectedParagraphCount = buildPlainChapterAnalysis(selectedBook).length;

    const plainAnalyses = buildPlainChapterAnalysis(selectedBook);
    const canPreserveExisting = (
      mode === 'preserve'
      && chapterAnalysisRef.current.length === expectedParagraphCount
      && chapterAnalysisRef.current.every((analysis, index) => analysis.paragraphText === (plainAnalyses[index]?.paragraphText ?? ''))
    );
    const initialAnalyses = canPreserveExisting ? chapterAnalysisRef.current.slice() : plainAnalyses;
    if (mode === 'reset' || !canPreserveExisting) {
      setChapterAnalysis(initialAnalyses);
    }
    clearDeferredHandle(deferredAnalysisHandleRef.current);
    deferredAnalysisHandleRef.current = null;

    if (!assistanceEnabledRef.current) {
      setChapterAnalysis(plainAnalyses);
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
          const processedParagraphIndices = new Set<number>();
          const deduplicationRadius = resolveDeduplicationRadius(settingsRef.current.deduplicationRadius);
          const threshold = resolveKnowledgeThreshold(settingsRef.current.knowledgeThreshold);
          const maxCardsPerParagraph = Math.max(1, Math.min(5, settingsRef.current.maxWordsPerParagraph));
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
            : resolveAnalysisAnchorIndex(
              expectedParagraphCount,
              selectedBook.currentChapterProgress,
            );
          const paragraphOrder = buildParagraphProcessingOrder(expectedParagraphCount, resolvedAnchorIndex);
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
            if (performance.now() - lastScrollActivityAtRef.current < ANALYSIS_SCROLL_SETTLE_MS) {
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
              const suppressedTargetKeys = new Set<string>();
              if (deduplicationRadius > 0) {
                for (const seenIndex of processedParagraphIndices) {
                  if (Math.abs(seenIndex - paragraphIndex) > deduplicationRadius) {
                    continue;
                  }
                  const nearbyAnalysis = nextAnalyses[seenIndex];
                  for (const target of nearbyAnalysis.cardTargets) {
                    suppressedTargetKeys.add(definitionTargetKey(target));
                  }
                }
              }
              const deduplicatedCardTargets = selectDeduplicatedCardTargets(
                analysis.tokens,
                maxCardsPerParagraph,
                threshold,
                suppressedTargetKeys,
              );
              const nextAnalysis: ParagraphAnalysis = {
                ...analysis,
                cardTargets: deduplicatedCardTargets,
              };
              nextAnalyses[paragraphIndex] = nextAnalysis;

              for (const target of nextAnalysis.cardTargets) {
                requestAutomaticDefinition(resources, target);
              }
              processedParagraphIndices.add(paragraphIndex);
            } catch (error) {
              console.warn('reader-paragraph-analysis-failed', {
                error,
                chapter: selectedBook.currentChapter,
                paragraphIndex,
                bookId: selectedBook.id,
              });
            }

            if (analysisRunIdRef.current !== currentRunId) {
              return;
            }
            if (performance.now() - lastScrollActivityAtRef.current < ANALYSIS_SCROLL_SETTLE_MS) {
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
          if (initialReaderLoadPendingRef.current && analysisRunIdRef.current === currentRunId) {
            initialAnalysisFailedRef.current = true;
            for (const paragraphIndex of initialViewportParagraphsRef.current ?? []) {
              completedInitialAnalysisRef.current.add(paragraphIndex);
            }
            setInitialAnalysisRevision((revision) => revision + 1);
          }
        } finally {
          setActiveAnalysisRunId((activeRunId) => activeRunId === currentRunId ? null : activeRunId);
        }
      })();
    }, 700);
  }, [requestAutomaticDefinition, resolveAnalysisAnchorIndex]);

  const loadReaderState = useCallback(async () => {
    beginReaderLoading();
    setIsLoading(true);

    try {
      const preferredBook = bookId ? await getBookById(bookId) : null;
      const selectedBook = preferredBook ?? (await listBooks())[0] ?? null;
      if (!selectedBook) {
        setBook(null);
        setChapterAnalysis([]);
        setDefinitionsByLemma(new Map());
        resourcesRef.current = null;
        return;
      }

      const [model, lemmaDict, nlp] = await Promise.all([
        loadVocabularyModel(),
        loadLemmaDict(),
        loadCompromise(),
      ]);

      const resources: ReaderResources = {
        model,
        lemmaDict,
        lexicon: loadLexicon(),
        nlp,
        lexicalAnalysisCache: createLexicalAnalysisCache(),
      };
      resourcesRef.current = resources;

      setBook(selectedBook);
      recomputeVisibleAnalysis(selectedBook, resources, 'reset');
    } catch (error) {
      console.error('reader-load-failed', { error, bookId });
      initialReaderLoadPendingRef.current = false;
      setInitialViewportReady(true);
    } finally {
      setIsLoading(false);
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
  }, [assistanceEnabled, book, isLoading, recomputeVisibleAnalysis, settings]);

  useEffect(() => {
    void loadReaderState();
    const unsubscribe = listenStateUpdated(() => {
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
    return unsubscribe;
  }, [loadReaderState, recomputeVisibleAnalysis]);

  useEffect(() => () => {
    clearDeferredHandle(deferredAnalysisHandleRef.current);
    deferredAnalysisHandleRef.current = null;
  }, []);

  const markLemma = (lemma: string, known: boolean, sourceParagraphIndex?: number) => {
    if (typeof sourceParagraphIndex === 'number' && Number.isFinite(sourceParagraphIndex)) {
      pendingAnalysisAnchorIndexRef.current = sourceParagraphIndex;
    } else {
      pendingAnalysisAnchorIndexRef.current = null;
    }
    upsertObservation(lemma, known);
  };

  const persistCurrentChapterProgress = useCallback((force: boolean) => {
    const currentBook = bookRef.current;
    if (!currentBook) {
      return;
    }
    if (!force && isRestoringProgressRef.current) {
      return;
    }

    const progress = calculateScrollProgressFromDocument();
    if (!force && Math.abs(progress - lastPersistedChapterProgressRef.current) < 0.01) {
      return;
    }
    lastPersistedChapterProgressRef.current = progress;

    const nextBook: ImportedBook = {
      ...currentBook,
      currentChapterProgress: progress,
    };
    bookRef.current = nextBook;
    void upsertBook(nextBook).catch((error) => {
      console.warn('reader-scroll-progress-save-failed', { bookId: nextBook.id, chapter: nextBook.currentChapter, progress, error });
    });
  }, []);

  const scheduleChapterProgressPersist = useCallback(() => {
    if (progressPersistTimeoutRef.current !== null) {
      window.clearTimeout(progressPersistTimeoutRef.current);
    }
    progressPersistTimeoutRef.current = window.setTimeout(() => {
      progressPersistTimeoutRef.current = null;
      persistCurrentChapterProgress(false);
    }, 250);
  }, [persistCurrentChapterProgress]);

  const pendingReaderAnchorRef = useRef<string | null>(null);

  const restoreCurrentChapterProgress = useCallback((targetBook: ImportedBook) => {
    if (pendingReaderAnchorRef.current) {
      document.getElementById(pendingReaderAnchorRef.current)?.scrollIntoView({ behavior: 'auto', block: 'start' });
      return;
    }
    const targetScrollTop = calculateScrollTopFromProgress(targetBook.currentChapterProgress);
    window.scrollTo({ top: targetScrollTop, behavior: 'auto' });
  }, []);

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
      updatedAt: new Date().toISOString(),
    };
    openReaderChapter(nextBook);
    window.scrollTo({ top: 0, behavior: 'auto' });
    void upsertBook(nextBook).catch((error) => {
      console.warn('reader-chapter-progress-save-failed', { bookId: nextBook.id, chapter: nextBook.currentChapter, error });
    });
  };

  useEffect(() => {
    if (!book || isLoading) {
      return;
    }
    isRestoringProgressRef.current = true;
    lastPersistedChapterProgressRef.current = clampChapterProgress(book.currentChapterProgress);
    if (delayedRestoreTimeoutRef.current !== null) {
      window.clearTimeout(delayedRestoreTimeoutRef.current);
      delayedRestoreTimeoutRef.current = null;
    }

    requestAnimationFrame(() => {
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
      if (isRestoringProgressRef.current) {
        return;
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
  }, [scheduleChapterProgressPersist]);

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
  ) => {
    const target = resolveDefinitionWordTarget(click);
    const lookupCandidates = buildDefinitionLookupCandidates(
      click.definitionText,
      click.start,
      click.end,
      target,
    );
    const popup = createWordPopupFromElement(
      click.element,
      lookupCandidates,
      sourceParagraphIndex,
      click.definitionText,
    );
    setWordPopups((previous) => {
      const ancestors = parentPopupIndex === null
        ? []
        : previous.slice(0, parentPopupIndex + 1);
      return [...ancestors, popup];
    });
    requestPopupDefinition(popup);
  }, [createWordPopupFromElement, requestPopupDefinition, resolveDefinitionWordTarget]);

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
    if (!book || isLoading || !initialReaderLoadPendingRef.current || initialViewportParagraphsRef.current !== null) return;
    const paragraphCount = book.chapters[clampChapterNumber(book, book.currentChapter) - 1]?.paragraphs.length ?? 0;
    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const viewportParagraphs = measureVisibleReaderParagraphs(
          paraRefs.current,
          paragraphCount,
          window.innerHeight,
        );
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
  }, [book, isLoading, initialProgressRestored, resolveAnalysisAnchorIndex]);

  useEffect(() => {
    const visibleParagraphs = initialViewportParagraphsRef.current;
    if (!initialReaderLoadPendingRef.current || !book || isLoading || !assistanceEnabled) return;
    if (!visibleParagraphs || visibleParagraphs.some((index) => !completedInitialAnalysisRef.current.has(index))) {
      setInitialLoadingMessage('Choosing difficult words...');
      return;
    }
    if (!areInitialReaderCardsReady(
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
    const visibleCardsReady = visibleParagraphs.every((index) =>
      chapterAnalysis[index].cardTargets.every((target) =>
        readyInitialCardsRef.current.has(`${index}:${definitionTargetKey(target)}`)));
    if (!visibleCardsReady) {
      setInitialLoadingMessage(settings.wsdMode === 'none' ? 'Fetching definitions...' : 'Performing WSD...');
      return;
    }
    if (!initialProgressRestored) return;
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
  ]);

  const readerLoading = isLoading || (book !== null && !initialViewportReady);
  useLayoutEffect(() => {
    if (!readerLoading) return;
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    const previousScrollbarGutter = root.style.scrollbarGutter;
    root.style.scrollbarGutter = 'stable';
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = previousOverflow;
      root.style.scrollbarGutter = previousScrollbarGutter;
    };
  }, [readerLoading]);

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
  const currentChapterNumber = clampChapterNumber(book, book.currentChapter);
  const currentChapter = book.chapters[currentChapterNumber - 1];
  const chapterParagraphs = currentChapter?.paragraphs ?? [];
  const chapterDisplayTitle = currentChapter ? chapterTitleForReader(currentChapter, currentChapterNumber) : null;
  const profileStateForRender = loadProfileState();
  const activeProfileForRender = getActiveProfile(profileStateForRender);
  const observationLabels = activeProfileForRender.observations;
  const chapterReaderBlocks = readerBlocksForChapter(chapterParagraphs, currentChapter?.readerBlocks);
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
    <div className="min-h-screen bg-background text-foreground" style={!initialViewportReady ? { visibility: 'hidden' } : undefined}>
      {readerSettingsOpen && (
        <div
          className="fixed inset-0 z-10 bg-black/20"
          aria-hidden="true"
          onClick={() => setReaderSettingsOpen(false)}
        />
      )}
      <header className={cn(
        'fixed top-0 inset-x-0 z-20 bg-background/95 backdrop-blur-sm border-b border-border transition-transform duration-300',
        headerVisible ? 'translate-y-0' : '-translate-y-full'
      )}>
        <div className="container mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <Link href="/">
              <Button
                variant="ghost"
                size="sm"
                className="gap-2 text-muted-foreground hover:text-foreground"
                data-testid="button-back-library"
                onClick={() => persistCurrentChapterProgress(true)}
              >
                <ChevronLeft size={18} /><span className="hidden sm:inline">Library</span>
              </Button>
            </Link>
          </div>
          <div className="font-serif text-sm font-medium text-muted-foreground hidden md:block">
            {book.title} — Chapter {currentChapterNumber}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-muted-foreground hover:text-foreground"
              onClick={openChapterStudy}
              disabled={!currentChapter || chapterParagraphs.length === 0 || !resourcesRef.current}
              data-testid="button-study-chapter"
            >
              <GraduationCap size={18} />
              <span>Study</span>
            </Button>
            <Button variant="ghost" size="icon"
              onClick={() => setAssistanceEnabled(!assistanceEnabled)}
              className={cn('text-muted-foreground transition-colors', assistanceEnabled && 'text-primary bg-primary/10')}
              aria-label="Toggle vocabulary assistance" data-testid="button-toggle-assistance">
              {assistanceEnabled ? <Eye size={18} /> : <EyeOff size={18} />}
            </Button>
            <Sheet modal={false} open={readerSettingsOpen} onOpenChange={setReaderSettingsOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="text-muted-foreground" data-testid="button-reader-settings">
                  <Type size={18} />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" disableAnimation className="w-[300px] sm:w-[400px] overflow-y-auto">
                <SheetHeader className="mb-6">
                  <SheetTitle className="font-serif">Reader Settings</SheetTitle>
                </SheetHeader>
                <div className="space-y-8">
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
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => { void deleteCurrentBook(); }}>
                  <Trash2 size={16} />
                  Delete Book
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <div className="h-14" />

      <main
        className={cn('mx-auto px-4 sm:px-6', getOuterWidthClass())}
        onClick={() => {
          scrollDirectionRef.current = 0;
          lastScrollY.current = window.scrollY;
          setHeaderVisible(true);
        }}
      >
        <div className="py-12 md:py-20" data-testid="reading-row">
          <div className="flex-1 min-w-0 flex flex-col" data-testid="left-column">
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
                if (targetChapter === currentChapterNumber) {
                  document.getElementById(anchor)?.scrollIntoView({ behavior: 'auto', block: 'start' });
                  return;
                }
                persistCurrentChapterProgress(true);
                pendingReaderAnchorRef.current = anchor;
                const nextBook: ImportedBook = { ...book, currentChapter: targetChapter, currentChapterProgress: 0, updatedAt: new Date().toISOString() };
                openReaderChapter(nextBook);
                void upsertBook(nextBook).catch((error) => console.warn('reader-link-progress-save-failed', { bookId: book.id, targetChapter, error }));
              }}
            >
              {chapterReaderBlocks.map((block, blockIndex) => {
                if (block.type === 'image') {
                  return (
                    <figure key={`reader-image-${blockIndex}`} className="my-6 w-full">
                      {block.anchorIds?.map((id) => <span key={id} id={id} className="reader-anchor" />)}
                      <img
                        src={block.src}
                        alt={block.alt}
                        title={block.title}
                        className="mx-auto block max-w-full"
                        style={block.style as CSSProperties | undefined}
                        loading="lazy"
                      />
                    </figure>
                  );
                }
                if (block.type === 'spacer') {
                  return <div key={`reader-spacer-${blockIndex}`} aria-hidden="true" style={{ height: '1em', ...block.style } as CSSProperties}>{block.anchorIds?.map((id) => <span key={id} id={id} className="reader-anchor" />)}</div>;
                }
                if (block.type === 'rule') {
                  return <div key={`reader-rule-${blockIndex}`}>{block.anchorIds?.map((id) => <span key={id} id={id} className="reader-anchor" />)}<hr className="my-8 border-border" style={block.style as CSSProperties | undefined} /></div>;
                }
                const sourceIndex = block.paragraphIndex;
                const visibleIndex = sourceIndex;
                const paragraphText = chapterParagraphs[sourceIndex] ?? '';
                const analysis = chapterAnalysis[sourceIndex] ?? { paragraphText, tokens: [], cardTargets: [] };
                return (
                <div key={`paragraph-${sourceIndex}`} className="mb-2" data-testid={`paragraph-block-${visibleIndex}`}>
                  <ReaderParagraphText
                    analysis={analysis}
                    block={block}
                    assistanceEnabled={assistanceEnabled}
                    sourceParagraphIndex={sourceIndex}
                    visibleParagraphIndex={visibleIndex}
                    onElementChange={setParagraphElement}
                    onOpenWordPopup={openRootWordPopup}
                  />
                  {assistanceEnabled && analysis.cardTargets.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-start gap-3 [&>[data-definition-card]]:w-[250px]" data-testid={`mobile-card-group-${visibleIndex}`}>
                      {analysis.cardTargets.map((target) => {
                        const rawDefinition = definitionsByLemma.get(target.lemma)
                          ?? createFallbackLexiconEntry(target.lemma);
                        const definition = resolveLexiconEntry(rawDefinition, target);
                        const definitionStatus: DefinitionLoadStatus = loadingDefinitionLemmas.has(target.lemma)
                          ? 'loading'
                          : failedDefinitionLemmas.has(target.lemma) ? 'error' : 'ready';
                        const observation = observationLabels[target.lemma];
                        return (
                          <ContextualDefinitionCard
                            key={definitionTargetKey(target)}
                            onReadinessChange={(ready) => recordInitialCardReadiness(sourceIndex, definitionTargetKey(target), ready)}
                            definition={definition}
                            context={contextForCard(analysis, target)}
                            contextParagraphs={chapterParagraphs}
                            contextParagraphIndex={sourceIndex}
                            wsdMode={settings.wsdMode}
                            wsdPriority="card"
                            getPriorityTarget={getParagraphElement}
                            priorityTargetIndex={visibleIndex}
                            wsdMargin={settings.wsdMode === 'none' ? 0 : marginForReductionLevel(settings.wsdReductionLevel, settings.wsdMode)}
                            wsdContextUnit={settings.wsdContextUnit}
                            wsdContextSize={settings.wsdContextSize}
                            activeDefinitionSelection={wordPopups[0]?.triggerSelection ?? undefined}
                            fontSize={settings.fontSize}
                            definitionStatus={definitionStatus}
                            onDefinitionWordClick={(click) => {
                              openDefinitionWordPopup(null, click, sourceIndex);
                            }}
                            onMarkKnown={() => markLemma(target.lemma, true, sourceIndex)}
                            onMarkUnknown={() => markLemma(target.lemma, false, sourceIndex)}
                            isMarkedKnown={observation === 1}
                            isMarkedUnknown={observation === 0}
                            pronunciationVariant={settings.englishVariant}
                            compact
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
                );
              })}
            </div>

            <div className="mt-20 pt-8 border-t border-border flex justify-between items-center text-muted-foreground font-serif">
              <Button
                variant="ghost"
                className="gap-1 px-2 text-xs sm:gap-2 sm:px-4 sm:text-sm"
                data-testid="button-prev-chapter"
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
                onClick={() => void updateCurrentChapter(1)}
              >
                <span className="sm:hidden">Next</span>
                <span className="hidden sm:inline">Next Chapter</span>
                <ChevronLeft size={16} className="rotate-180" />
              </Button>
            </div>
          </div>

        </div>
      </main>
      {activeAnalysisRunId !== null && (
        <div className="pointer-events-none fixed bottom-4 right-4 z-30 text-muted-foreground">
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
                openDefinitionWordPopup(popupIndex, click, popup.sourceParagraphIndex);
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
    {!initialViewportReady && (
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
