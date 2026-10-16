import { readerBlocksForChapter } from './reader-content.js';
import type { BookChapter, BookNavigationEntry, ImportedBook, ReaderLocation } from './types';

/** Return the reader location for a block in a chapter, including its canonical text offset. */
export function readerLocationForBlock(chapter: BookChapter, chapterIndex: number, blockIndex: number): ReaderLocation {
  const blocks = readerBlocksForChapter(chapter.paragraphs, chapter.readerBlocks);
  const block = blocks[blockIndex];
  if (!block) throw new Error(`Navigation block is outside the chapter: chapterIndex=${chapterIndex}, blockIndex=${blockIndex}`);
  return {
    chapterIndex,
    blockIndex,
    textOffset: 0,
  };
}

/** Map a flat reader block offset to the chapter and block indexes used by the reader. */
export function readerLocationAtOffset(chapters: BookChapter[], blockOffset: number): ReaderLocation {
  if (!Number.isInteger(blockOffset) || blockOffset < 0) {
    throw new Error(`Navigation block offset must be a non-negative integer: blockOffset=${blockOffset}`);
  }
  let remaining = blockOffset;
  for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex += 1) {
    const blocks = readerBlocksForChapter(chapters[chapterIndex].paragraphs, chapters[chapterIndex].readerBlocks);
    if (remaining < blocks.length) return readerLocationForBlock(chapters[chapterIndex], chapterIndex, remaining);
    remaining -= blocks.length;
  }
  throw new Error(`Navigation block offset is outside the book: blockOffset=${blockOffset}`);
}

/** Build explicit chapter navigation for old books that have no stored navigation metadata. */
export function chapterNavigation(chapters: BookChapter[], idPrefix: string, chapterIndexOffset: number): BookNavigationEntry[] {
  return chapters.flatMap((chapter, chapterIndex) => {
    const blocks = readerBlocksForChapter(chapter.paragraphs, chapter.readerBlocks);
    if (blocks.length === 0) return [];
    return [{
      id: `${idPrefix}-chapter-${chapterIndex}`,
      title: chapter.title,
      location: readerLocationForBlock(chapter, chapterIndex + chapterIndexOffset, 0),
      children: [],
    }];
  });
}

/** Supply chapter navigation when persisted books predate the navigation field. */
export function navigationForBook(book: Pick<ImportedBook, 'chapters' | 'navigation'>): BookNavigationEntry[] {
  return book.navigation?.length ? book.navigation : chapterNavigation(book.chapters, 'legacy', 0);
}

