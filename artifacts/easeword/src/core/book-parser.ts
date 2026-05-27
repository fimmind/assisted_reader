import type { BookChapter, ImportedBook } from './types';
import { createId } from './math';
import { loadJsZip } from './external';

interface ParsedBookPayload {
  title: string;
  author: string;
  sourceType: 'txt' | 'epub';
  chapters: BookChapter[];
}

function normalizeParagraphs(chunks: string[]): string[] {
  return chunks
    .map((chunk) => chunk.replace(/\s+/g, ' ').trim())
    .filter((chunk) => chunk.length > 0);
}

export function parseTxtBook(text: string): BookChapter[] {
  const chapterHeadingRegex = /^\s*(chapter\s+\d+.*)$/gim;
  const headingMatches = Array.from(text.matchAll(chapterHeadingRegex));

  if (headingMatches.length === 0) {
    return [{
      title: 'Chapter 1',
      paragraphs: normalizeParagraphs(text.split(/\n\s*\n+/)),
    }];
  }

  const chapters: BookChapter[] = [];
  for (let index = 0; index < headingMatches.length; index += 1) {
    const current = headingMatches[index];
    const next = headingMatches[index + 1];
    const start = current.index ?? 0;
    const end = next?.index ?? text.length;
    const chapterSlice = text.slice(start, end);
    const lines = chapterSlice.split('\n');
    const title = lines[0].trim();
    const content = lines.slice(1).join('\n');

    chapters.push({
      title,
      paragraphs: normalizeParagraphs(content.split(/\n\s*\n+/)),
    });
  }

  return chapters.filter((chapter) => chapter.paragraphs.length > 0);
}

function resolveRelativePath(basePath: string, relativePath: string): string {
  const baseParts = basePath.split('/');
  baseParts.pop();
  const relParts = relativePath.split('/');

  for (const part of relParts) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      baseParts.pop();
      continue;
    }
    baseParts.push(part);
  }

  return baseParts.join('/');
}

function parseXml(xmlText: string): Document {
  const parser = new DOMParser();
  return parser.parseFromString(xmlText, 'application/xml');
}

function parseHtml(htmlText: string): Document {
  const parser = new DOMParser();
  return parser.parseFromString(htmlText, 'text/html');
}

function extractChapterTitle(doc: Document, fallbackIndex: number): string {
  const heading = doc.querySelector('h1, h2, title');
  const value = heading?.textContent?.trim();
  if (value && value.length > 0) {
    return value;
  }
  return `Chapter ${fallbackIndex}`;
}

function splitFallbackParagraphs(text: string): string[] {
  return normalizeParagraphs(text.split(/(?<=[.!?])\s+/));
}

async function parseEpubBook(buffer: ArrayBuffer): Promise<BookChapter[]> {
  const JSZip = await loadJsZip();
  const zip = await JSZip.loadAsync(buffer);

  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) {
    throw new Error('EPUB parsing failed: META-INF/container.xml not found.');
  }

  const containerXml = await containerFile.async('string');
  const containerDoc = parseXml(containerXml);
  const rootfile = containerDoc.querySelector('rootfile');
  const opfPath = rootfile?.getAttribute('full-path');
  if (!opfPath) {
    throw new Error('EPUB parsing failed: OPF package path is missing in container.xml.');
  }

  const opfFile = zip.file(opfPath);
  if (!opfFile) {
    throw new Error(`EPUB parsing failed: OPF file missing at path=${opfPath}`);
  }

  const opfXml = await opfFile.async('string');
  const opfDoc = parseXml(opfXml);
  const manifestItems = new Map<string, string>();

  const manifestNodes = Array.from(opfDoc.querySelectorAll('manifest > item'));
  for (const item of manifestNodes) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (!id || !href) {
      continue;
    }
    manifestItems.set(id, href);
  }

  const spineRefs = Array.from(opfDoc.querySelectorAll('spine > itemref'));
  const chapters: BookChapter[] = [];

  for (let index = 0; index < spineRefs.length; index += 1) {
    const itemRef = spineRefs[index];
    const idRef = itemRef.getAttribute('idref');
    if (!idRef) {
      continue;
    }
    const href = manifestItems.get(idRef);
    if (!href) {
      continue;
    }

    const contentPath = resolveRelativePath(opfPath, href);
    const chapterFile = zip.file(contentPath);
    if (!chapterFile) {
      continue;
    }

    const chapterMarkup = await chapterFile.async('string');
    const chapterDoc = parseHtml(chapterMarkup);
    const title = extractChapterTitle(chapterDoc, index + 1);

    const paragraphNodes = Array.from(chapterDoc.querySelectorAll('p'));
    let paragraphs = paragraphNodes
      .map((node) => node.textContent ?? '')
      .map((text) => text.replace(/\s+/g, ' ').trim())
      .filter((text) => text.length > 0);

    if (paragraphs.length === 0) {
      const fallbackText = chapterDoc.body?.textContent ?? chapterDoc.documentElement.textContent ?? '';
      paragraphs = splitFallbackParagraphs(fallbackText);
    }

    if (paragraphs.length > 0) {
      chapters.push({ title, paragraphs });
    }
  }

  if (chapters.length === 0) {
    throw new Error('EPUB parsing failed: no readable chapters found in spine content.');
  }

  return chapters;
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
    return {
      title,
      author: 'Unknown Author',
      sourceType: 'txt',
      chapters: parseTxtBook(text),
    };
  }

  if (lowerName.endsWith('.epub')) {
    const buffer = await file.arrayBuffer();
    const chapters = await parseEpubBook(buffer);
    return {
      title,
      author: 'Unknown Author',
      sourceType: 'epub',
      chapters,
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
    chapters: parsed.chapters,
  };

  return book;
}
