import { readerBlocksForChapter } from './reader-content.js';
import type { BookChapter, ImportedBook, ReaderContentBlock, ReaderLocation } from './types.js';

type LocationBook = Pick<ImportedBook, 'chapters'>;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function chapterBlocks(chapter: BookChapter): ReaderContentBlock[] {
  return readerBlocksForChapter(chapter.paragraphs, chapter.readerBlocks);
}

function chapterTextLength(chapter: BookChapter): number {
  return chapter.paragraphs.reduce((total, paragraph) => total + paragraph.length, 0);
}

function isLinear(chapter: BookChapter): boolean {
  return chapter.linear !== false;
}

function locationTextOffset(chapter: BookChapter, blockIndex: number): number {
  const blocks = chapterBlocks(chapter);
  const safeBlockIndex = clamp(Math.trunc(blockIndex), 0, Math.max(0, blocks.length - 1));
  const block = blocks[safeBlockIndex];
  if (!block) return 0;
  const boundary = block.type === 'paragraph' ? block.paragraphIndex : block.afterParagraphIndex;
  const precedingText = chapter.paragraphs
    .slice(0, boundary)
    .reduce((total, paragraph) => total + paragraph.length, 0);
  return precedingText;
}

function getAbsoluteTextOffset(book: LocationBook, location: ReaderLocation): number {
  const chapterIndex = clamp(Math.trunc(location.chapterIndex), 0, Math.max(0, book.chapters.length - 1));
  const chapter = book.chapters[chapterIndex];
  if (!chapter) return 0;
  const offsetBeforeChapter = book.chapters
    .slice(0, chapterIndex)
    .filter(isLinear)
    .reduce((total, item) => total + chapterTextLength(item), 0);
  if (!isLinear(chapter)) return offsetBeforeChapter;
  const blocks = chapterBlocks(chapter);
  const blockIndex = clamp(Math.trunc(location.blockIndex), 0, Math.max(0, blocks.length - 1));
  const block = blocks[blockIndex];
  if (!block) return offsetBeforeChapter;
  const paragraphBoundary = block.type === 'paragraph' ? block.paragraphIndex : block.afterParagraphIndex;
  const beforeBlock = chapter.paragraphs.slice(0, paragraphBoundary)
    .reduce((total, paragraph) => total + paragraph.length, 0);
  if (block.type !== 'paragraph') return offsetBeforeChapter + beforeBlock;
  const paragraph = chapter.paragraphs[block.paragraphIndex] ?? '';
  return offsetBeforeChapter + beforeBlock + clamp(location.textOffset, 0, paragraph.length);
}

/** Validate a saved location and clamp it to the book's current chapter and reader-block structure. */
export function resolveReaderLocation(book: LocationBook, location: ReaderLocation): ReaderLocation {
  if (!Number.isFinite(location.chapterIndex) || !Number.isFinite(location.blockIndex) || !Number.isFinite(location.textOffset)) {
    throw new RangeError('Reader location values must be finite numbers.');
  }
  if (book.chapters.length === 0) return { chapterIndex: 0, blockIndex: 0, textOffset: 0 };
  const chapterIndex = clamp(Math.trunc(location.chapterIndex), 0, book.chapters.length - 1);
  const chapter = book.chapters[chapterIndex];
  const blocks = chapterBlocks(chapter);
  const blockIndex = clamp(Math.trunc(location.blockIndex), 0, Math.max(0, blocks.length - 1));
  const block = blocks[blockIndex];
  const textOffset = block?.type === 'paragraph'
    ? clamp(Math.trunc(location.textOffset), 0, chapter.paragraphs[block.paragraphIndex]?.length ?? 0)
    : 0;
  return { chapterIndex, blockIndex, textOffset };
}

/** Convert a reader location to whole-book progress weighted by canonical text length. */
export function bookProgressAtLocation(book: LocationBook, location: ReaderLocation): number {
  const totalText = book.chapters.filter(isLinear).reduce((total, chapter) => total + chapterTextLength(chapter), 0);
  if (totalText === 0) return 0;
  return clamp(getAbsoluteTextOffset(book, resolveReaderLocation(book, location)) / totalText, 0, 1);
}

/** Convert a reader location to progress within its chapter. Supplementary chapters have no sequential progress. */
export function chapterProgressAtLocation(chapter: BookChapter, blockIndex: number, textOffset: number): number {
  if (!isLinear(chapter)) return 0;
  const totalText = chapterTextLength(chapter);
  if (totalText === 0) return 0;
  const localOffset = locationTextOffset(chapter, blockIndex);
  const blocks = chapterBlocks(chapter);
  const block = blocks[clamp(Math.trunc(blockIndex), 0, Math.max(0, blocks.length - 1))];
  const normalizedOffset = block?.type === 'paragraph'
    ? localOffset + clamp(Math.trunc(textOffset), 0, chapter.paragraphs[block.paragraphIndex]?.length ?? 0)
    : localOffset;
  return clamp(normalizedOffset / totalText, 0, 1);
}

/** Map a whole-book text fraction to a canonical reader location. */
export function readerLocationAtBookProgress(book: LocationBook, fraction: number): ReaderLocation {
  if (!Number.isFinite(fraction)) throw new RangeError('Book progress must be finite.');
  if (book.chapters.length === 0) return { chapterIndex: 0, blockIndex: 0, textOffset: 0 };
  const linearChapters = book.chapters.map((chapter, chapterIndex) => ({ chapter, chapterIndex }))
    .filter(({ chapter }) => isLinear(chapter));
  const totalText = linearChapters.reduce((total, { chapter }) => total + chapterTextLength(chapter), 0);
  if (totalText === 0) return { chapterIndex: linearChapters[0]?.chapterIndex ?? 0, blockIndex: 0, textOffset: 0 };
  let remaining = clamp(fraction, 0, 1) * totalText;
  for (let linearIndex = 0; linearIndex < linearChapters.length; linearIndex += 1) {
    const { chapter, chapterIndex } = linearChapters[linearIndex];
    const length = chapterTextLength(chapter);
    const isLast = linearIndex === linearChapters.length - 1;
    if (remaining < length || isLast) {
      const localOffset = clamp(remaining, 0, length);
      let textRemaining = localOffset;
      const blocks = chapterBlocks(chapter);
      for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
        const block = blocks[blockIndex];
        if (block.type !== 'paragraph') continue;
        const paragraphLength = chapter.paragraphs[block.paragraphIndex]?.length ?? 0;
        if (textRemaining <= paragraphLength) {
          return { chapterIndex, blockIndex, textOffset: Math.floor(textRemaining) };
        }
        textRemaining -= paragraphLength;
      }
      let lastParagraphBlockIndex = -1;
      for (let index = 0; index < blocks.length; index += 1) {
        if (blocks[index].type === 'paragraph') lastParagraphBlockIndex = index;
      }
      return { chapterIndex, blockIndex: Math.max(0, lastParagraphBlockIndex), textOffset: 0 };
    }
    remaining -= length;
  }
  return { chapterIndex: 0, blockIndex: 0, textOffset: 0 };
}

/** Approximate a canonical location for legacy chapter-and-fraction progress. */
export function readerLocationFromLegacyProgress(
  book: LocationBook,
  currentChapter: number,
  currentChapterProgress: number,
): ReaderLocation {
  if (!Number.isFinite(currentChapter) || !Number.isFinite(currentChapterProgress)) {
    throw new RangeError('Legacy reading progress values must be finite numbers.');
  }
  if (book.chapters.length === 0) return { chapterIndex: 0, blockIndex: 0, textOffset: 0 };
  const chapterIndex = clamp(Math.trunc(currentChapter) - 1, 0, book.chapters.length - 1);
  const chapter = book.chapters[chapterIndex];
  if (!isLinear(chapter)) return readerLocationAtChapterProgress(chapter, chapterIndex, currentChapterProgress);
  const linearChapters = book.chapters.filter(isLinear);
  const totalText = linearChapters.reduce((total, item) => total + chapterTextLength(item), 0);
  if (totalText === 0) return { chapterIndex, blockIndex: 0, textOffset: 0 };
  return readerLocationAtChapterProgress(chapter, chapterIndex, currentChapterProgress);
}

function readerLocationAtChapterProgress(chapter: BookChapter, chapterIndex: number, fraction: number): ReaderLocation {
  const targetOffset = Math.floor(clamp(fraction, 0, 1) * chapterTextLength(chapter));
  let remaining = targetOffset;
  const blocks = chapterBlocks(chapter);
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    if (block.type !== 'paragraph') continue;
    const paragraphLength = chapter.paragraphs[block.paragraphIndex]?.length ?? 0;
    if (remaining < paragraphLength) return { chapterIndex, blockIndex, textOffset: remaining };
    remaining -= paragraphLength;
  }
  let lastParagraphBlockIndex = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    if (blocks[index].type === 'paragraph') lastParagraphBlockIndex = index;
  }
  const lastBlock = blocks[lastParagraphBlockIndex];
  const lastLength = lastBlock?.type === 'paragraph' ? chapter.paragraphs[lastBlock.paragraphIndex]?.length ?? 0 : 0;
  return { chapterIndex, blockIndex: lastParagraphBlockIndex, textOffset: lastLength };
}

interface ReaderBlockElement extends HTMLElement {
  dataset: DOMStringMap & { readerBlockIndex?: string };
}

/** Capture the first visible reader block and its canonical text offset from rendered DOM. */
export function captureVisibleReaderLocation(
  root: ParentNode,
  chapterIndex: number,
  viewportTop: number,
  viewportBottom: number,
): ReaderLocation | null {
  if (!Number.isFinite(viewportTop) || !Number.isFinite(viewportBottom) || viewportBottom <= viewportTop) {
    throw new RangeError('Reader viewport bounds must be finite and ordered.');
  }
  const rows = Array.from(root.querySelectorAll<ReaderBlockElement>('[data-reader-block-index]'));
  const visible = rows.find((element) => {
    const rect = element.getBoundingClientRect();
    return rect.bottom > viewportTop && rect.top < viewportBottom;
  });
  if (!visible) return null;
  const blockIndex = Number(visible.dataset.readerBlockIndex);
  if (!Number.isInteger(blockIndex) || blockIndex < 0) throw new Error('Visible reader block has an invalid data-reader-block-index.');
  const range = document.createRange();
  const textBlock = visible.querySelector<HTMLElement>('[data-reader-text-block]');
  if (!textBlock) return { chapterIndex, blockIndex, textOffset: 0 };
  const walker = document.createTreeWalker(textBlock, NodeFilter.SHOW_TEXT);
  const textNodes: Array<{ node: Text; start: number; length: number }> = [];
  let totalLength = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const textNode = node as Text;
    const length = textNode.textContent?.length ?? 0;
    textNodes.push({ node: textNode, start: totalLength, length });
    totalLength += length;
  }
  if (textNodes.length === 0) return { chapterIndex, blockIndex, textOffset: 0 };
  const rectForOffset = (textOffset: number): DOMRect => {
    let selected = textNodes[textNodes.length - 1];
    for (const item of textNodes) {
      if (textOffset <= item.start + item.length) {
        selected = item;
        break;
      }
    }
    const nodeOffset = clamp(textOffset - selected.start, 0, selected.length);
    const endOffset = Math.min(selected.length, nodeOffset + 1);
    range.setStart(selected.node, nodeOffset);
    range.setEnd(selected.node, endOffset);
    return range.getBoundingClientRect();
  };
  let low = 0;
  let high = totalLength;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rectForOffset(middle).bottom <= viewportTop) low = middle + 1;
    else high = middle;
  }
  const rect = rectForOffset(low);
  if (rect.top >= viewportBottom) return { chapterIndex, blockIndex, textOffset: 0 };
  return { chapterIndex, blockIndex, textOffset: low };
}

/** Scroll the rendered canonical text offset into view after the requested chapter has rendered. */
export function restoreReaderLocation(root: ParentNode, location: ReaderLocation, topInset: number): boolean {
  if (!Number.isFinite(topInset) || topInset < 0) throw new RangeError('Reader restore top inset must be a non-negative finite number.');
  if (location.blockIndex === 0 && location.textOffset === 0 && root instanceof HTMLElement) {
    const rootTop = root.getBoundingClientRect().top;
    window.scrollBy({ top: rootTop - topInset, behavior: 'instant' as ScrollBehavior });
    return true;
  }
  const row = root.querySelector<ReaderBlockElement>(`[data-reader-block-index="${location.blockIndex}"]`);
  if (!row) return false;
  const element = row.querySelector<HTMLElement>('[data-reader-text-block]');
  if (!element) {
    window.scrollBy({ top: row.getBoundingClientRect().top - topInset, behavior: 'instant' as ScrollBehavior });
    return true;
  }
  const range = document.createRange();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const textNodes: Array<{ node: Node; start: number; length: number }> = [];
  let totalLength = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (length > 0) textNodes.push({ node, start: totalLength, length });
    totalLength += length;
  }
  if (textNodes.length === 0) {
    window.scrollBy({ top: element.getBoundingClientRect().top - topInset, behavior: 'instant' as ScrollBehavior });
    return true;
  }
  const targetOffset = clamp(location.textOffset, 0, totalLength);
  const selected = textNodes.find((item) => targetOffset < item.start + item.length)
    ?? textNodes[textNodes.length - 1];
  const characterOffset = clamp(targetOffset - selected.start, 0, selected.length - 1);
  range.setStart(selected.node, characterOffset);
  range.setEnd(selected.node, characterOffset + 1);
  const rect = range.getBoundingClientRect();
  if (rect.height > 0) {
    window.scrollBy({ top: rect.top - topInset, behavior: 'instant' as ScrollBehavior });
  } else {
    window.scrollBy({ top: element.getBoundingClientRect().top - topInset, behavior: 'instant' as ScrollBehavior });
  }
  return true;
}
