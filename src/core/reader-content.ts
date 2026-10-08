import type { BookChapter, ReaderContentBlock, ReaderParagraphBlock } from './types';

/** Navigation labels never replace authored text, styles, or anchors. */
export function chapterTitleForReader(chapter: BookChapter, chapterNumber: number): string | null {
  if (chapter.titlePresentation === 'content' || chapter.titlePresentation === 'continuation') return null;
  const title = chapter.title.replace(/\s+/g, ' ').trim();
  const first = chapter.paragraphs[0]?.replace(/\s+/g, ' ').trim() ?? '';
  const openingBlock = chapter.readerBlocks?.find((block) => block.type === 'paragraph');
  if (chapter.titlePresentation !== 'generated') {
    if (openingBlock?.type === 'paragraph' && openingBlock.paragraphIndex === 0 && openingBlock.blockType === 'heading') return null;
    if (first && first.toLowerCase() === title.toLowerCase()) return null;
    if (/^chapter\.?$/i.test(title) && /^chapter\b/i.test(first)) return null;
  }
  return !title || /^chapter\.?$/i.test(title) ? `Chapter ${chapterNumber}` : title;
}

/** Complete legacy plain-text chapters without changing paragraph indexes or rich text projections. */
export function readerBlocksForChapter(paragraphs: string[], readerBlocks: ReaderContentBlock[] | undefined): ReaderContentBlock[] {
  const paragraphsByIndex = new Map<number, ReaderParagraphBlock>();
  const mediaByBoundary = new Map<number, ReaderContentBlock[]>();
  for (const block of readerBlocks ?? []) {
    if (block.type === 'paragraph') {
      const renderedText = block.content.map((part) => part.type === 'text' ? part.text : '').join('');
      if (renderedText !== paragraphs[block.paragraphIndex]) {
        throw new Error(`Reader text does not match its analysis paragraph: paragraphIndex=${block.paragraphIndex}`);
      }
      if (paragraphsByIndex.has(block.paragraphIndex)) throw new Error(`Duplicate reader paragraph: paragraphIndex=${block.paragraphIndex}`);
      paragraphsByIndex.set(block.paragraphIndex, block);
    } else {
      const boundary = mediaByBoundary.get(block.afterParagraphIndex) ?? [];
      mediaByBoundary.set(block.afterParagraphIndex, [...boundary, block]);
    }
  }
  const ordered: ReaderContentBlock[] = [];
  for (let paragraphIndex = 0; paragraphIndex <= paragraphs.length; paragraphIndex += 1) {
    ordered.push(...(mediaByBoundary.get(paragraphIndex) ?? []));
    if (paragraphIndex >= paragraphs.length) continue;
    ordered.push(paragraphsByIndex.get(paragraphIndex) ?? {
      type: 'paragraph', paragraphIndex, blockType: 'paragraph',
      content: [{ type: 'text', text: paragraphs[paragraphIndex], marks: [] }],
    });
  }
  return ordered;
}

export function readerAnchorChapter(chapters: BookChapter[], anchorId: string): number | null {
  const index = chapters.findIndex((chapter) => chapter.readerBlocks?.some((block) => block.anchorIds?.includes(anchorId)));
  return index < 0 ? null : index + 1;
}

export function adjacentReadingChapter(chapters: BookChapter[], currentChapter: number, delta: -1 | 1): number {
  for (let index = currentChapter - 1 + delta; index >= 0 && index < chapters.length; index += delta) {
    if (chapters[index].linear !== false) return index + 1;
  }
  return currentChapter;
}
