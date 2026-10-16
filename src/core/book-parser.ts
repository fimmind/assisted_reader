import { chapterNavigation } from './book-navigation.js';
import type { BookChapter, BookNavigationEntry, ImportedBook } from './types';
import { createId } from './math.js';

interface ParsedBookPayload {
  title: string;
  author: string;
  sourceType: ImportedBook['sourceType'];
  chapters: BookChapter[];
  navigation?: BookNavigationEntry[];
}

function normalizeParagraphs(chunks: string[]): string[] {
  return chunks
    .map((chunk) => chunk.replace(/\s+/g, ' ').trim())
    .filter((chunk) => chunk.length > 0);
}

export function parseTxtBook(text: string): BookChapter[] {
  const chapterHeadingRegex = /^[\t ]*((?:chapter|part)[\t ]+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)(?:[\t ]*[:.\-]?[\t ]+[^\r\n]*)?)[\t ]*\r?$/gim;
  const headingMatches = Array.from(text.matchAll(chapterHeadingRegex));

  if (headingMatches.length === 0) {
    return [{
      title: 'Chapter 1',
      paragraphs: normalizeParagraphs(text.split(/\n\s*\n+/)),
    }];
  }

  const chapters: BookChapter[] = [];
  const preamble = text.slice(0, headingMatches[0].index ?? 0);
  const preambleParagraphs = normalizeParagraphs(preamble.split(/\n\s*\n+/));
  if (preambleParagraphs.length) chapters.push({ title: 'Front matter', paragraphs: preambleParagraphs });
  for (let index = 0; index < headingMatches.length; index += 1) {
    const current = headingMatches[index];
    const next = headingMatches[index + 1];
    const start = (current.index ?? 0) + current[0].length;
    const end = next?.index ?? text.length;
    const title = current[1].trim();
    const content = text.slice(start, end);

    chapters.push({
      title,
      paragraphs: normalizeParagraphs(content.split(/\n\s*\n+/)),
    });
  }

  return chapters.filter((chapter) => chapter.paragraphs.length > 0);
}

function parseTextNavigation(chapters: BookChapter[]): BookNavigationEntry[] {
  return chapterNavigation(chapters, 'txt', 0);
}

function inferTitleFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/, '');
  if (withoutExtension.trim().length === 0) {
    return 'Imported Book';
  }
  return withoutExtension;
}

async function parseUploadedBook(file: File): Promise<ParsedBookPayload> {
  const lowerName = file.name.toLowerCase();
  const title = inferTitleFromFileName(file.name);

  if (lowerName.endsWith('.txt')) {
    const text = await file.text();
    const chapters = parseTxtBook(text);
    return {
      title,
      author: 'Unknown Author',
      sourceType: 'txt',
      chapters,
      navigation: parseTextNavigation(chapters),
    };
  }

  if (lowerName.endsWith('.epub')) {
    const buffer = await file.arrayBuffer();
    const { parseEpubBook } = await import('./epub-parser.js');
    const epub = await parseEpubBook(buffer);
    return {
      title: epub.title || title,
      author: epub.author || 'Unknown Author',
      sourceType: 'epub',
      chapters: epub.chapters,
      navigation: epub.navigation,
    };
  }

  if (lowerName.endsWith('.fb2')) {
    const { parseFb2Book } = await import('./fb2-parser.js');
    const fb2 = parseFb2Book(await file.arrayBuffer());
    return {
      title: fb2.title || title,
      author: fb2.author || 'Unknown Author',
      sourceType: 'fb2',
      chapters: fb2.chapters,
      navigation: fb2.navigation,
    };
  }

  if (lowerName.endsWith('.pdf')) {
    const { parsePdfBook } = await import('./pdf-parser');
    return {
      title,
      author: 'Unknown Author',
      sourceType: 'pdf',
      chapters: await parsePdfBook(await file.arrayBuffer()),
    };
  }

  throw new Error(`Unsupported file format for import: file=${file.name}`);
}

export async function importBookFromFile(file: File): Promise<ImportedBook> {
  const parsed = await parseUploadedBook(file);
  if (parsed.chapters.length === 0) {
    throw new Error(`Imported file produced no readable chapters: file=${file.name}`);
  }

  const nowIso = new Date().toISOString();
  const book: ImportedBook = {
    id: createId('book'),
    title: parsed.title,
    author: parsed.author,
    sourceType: parsed.sourceType,
    createdAt: nowIso,
    updatedAt: nowIso,
    currentChapter: 1,
    currentChapterProgress: 0,
    chapters: parsed.chapters,
    navigation: parsed.navigation ?? chapterNavigation(parsed.chapters, parsed.sourceType, 0),
  };

  return book;
}
