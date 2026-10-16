import { readerBlocksForChapter } from './reader-content.js';
import type { ImportedBook, ReaderLocation } from './types.js';

export interface ReaderSearchMatch {
  chapterIndex: number;
  paragraphIndex: number;
  startOffset: number;
  endOffset: number;
  location: ReaderLocation;
  snippet: string;
  snippetStartOffset: number;
}

export interface ReaderSearchOptions {
  maxResults: number;
  signal?: AbortSignal;
  contextCharacters?: number;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Search canonical paragraph text throughout a book with a bounded, cancellable result set. */
export async function searchBookText(
  book: Pick<ImportedBook, 'chapters'>,
  query: string,
  options: ReaderSearchOptions,
): Promise<ReaderSearchMatch[]> {
  if (!Number.isInteger(options.maxResults) || options.maxResults < 0) {
    throw new RangeError('Search maxResults must be a non-negative integer.');
  }
  const searchTerm = query.trim();
  if (!searchTerm || options.maxResults === 0) return [];
  const contextCharacters = options.contextCharacters ?? 48;
  if (!Number.isInteger(contextCharacters) || contextCharacters < 0) {
    throw new RangeError('Search contextCharacters must be a non-negative integer.');
  }
  const expression = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const matches: ReaderSearchMatch[] = [];
  let paragraphsSinceYield = 0;
  for (let chapterIndex = 0; chapterIndex < book.chapters.length; chapterIndex += 1) {
    if (options.signal?.aborted) return matches;
    const chapter = book.chapters[chapterIndex];
    const blocks = readerBlocksForChapter(chapter.paragraphs, chapter.readerBlocks);
    const blockIndexByParagraph = new Map<number, number>();
    blocks.forEach((block, blockIndex) => {
      if (block.type === 'paragraph') blockIndexByParagraph.set(block.paragraphIndex, blockIndex);
    });
    for (let paragraphIndex = 0; paragraphIndex < chapter.paragraphs.length; paragraphIndex += 1) {
      if (options.signal?.aborted) return matches;
      paragraphsSinceYield += 1;
      if (paragraphsSinceYield >= 32) {
        paragraphsSinceYield = 0;
        await yieldToEventLoop();
        if (options.signal?.aborted) return matches;
      }
      const paragraph = chapter.paragraphs[paragraphIndex];
      expression.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = expression.exec(paragraph)) !== null) {
        const startOffset = match.index;
        const endOffset = startOffset + match[0].length;
        const snippetStartOffset = Math.max(0, startOffset - contextCharacters);
        const snippetEndOffset = Math.min(paragraph.length, endOffset + contextCharacters);
        matches.push({
          chapterIndex,
          paragraphIndex,
          startOffset,
          endOffset,
          location: { chapterIndex, blockIndex: blockIndexByParagraph.get(paragraphIndex) ?? paragraphIndex, textOffset: startOffset },
          snippet: paragraph.slice(snippetStartOffset, snippetEndOffset),
          snippetStartOffset,
        });
        if (matches.length >= options.maxResults) return matches;
        if (match[0].length === 0) expression.lastIndex += 1;
      }
    }
  }
  return matches;
}
