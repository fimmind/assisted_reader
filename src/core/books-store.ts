import { BOOKS_DB_NAME, BOOKS_DB_VERSION, BOOKS_FALLBACK_STORAGE_KEY, BOOKS_STORE_NAME } from './constants';
import type {
  ImportedBook,
  ReaderContentBlock,
  ReaderContentStyle,
  ReaderInlineContent,
  ReaderInlineMark,
  ReaderParagraphBlock,
} from './types';

const DISMISSED_SEED_BOOK_KEY = 'easeword-dismissed-seed-book-v1';

function isIndexedDbAvailable(): boolean {
  return typeof window !== 'undefined' && 'indexedDB' in window;
}

function sortBooks(books: ImportedBook[]): ImportedBook[] {
  return [...books].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function normalizeChapterNumber(rawValue: unknown, chapterCount: number): number {
  if (chapterCount <= 0) {
    return 1;
  }
  if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
    return 1;
  }
  const integer = Math.trunc(rawValue);
  if (integer < 1) {
    return 1;
  }
  if (integer > chapterCount) {
    return chapterCount;
  }
  return integer;
}

function normalizeChapterProgress(rawValue: unknown): number {
  if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
    return 0;
  }
  if (rawValue < 0) {
    return 0;
  }
  if (rawValue > 1) {
    return 1;
  }
  return rawValue;
}

const READER_STYLE_KEYS: ReadonlySet<keyof ReaderContentStyle> = new Set([
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'color', 'backgroundColor', 'textDecoration',
  'textTransform', 'textAlign', 'textIndent', 'lineHeight', 'letterSpacing', 'wordSpacing', 'whiteSpace',
  'verticalAlign', 'direction', 'marginTop', 'marginBottom', 'margin', 'marginLeft', 'marginRight',
  'marginInlineStart', 'marginInlineEnd', 'paddingTop', 'paddingBottom', 'paddingInlineStart', 'paddingInlineEnd',
  'padding', 'paddingLeft', 'paddingRight', 'display', 'width', 'maxWidth', 'height', 'maxHeight',
  'minWidth', 'objectFit', 'objectPosition', 'borderTop', 'borderBottom', 'borderColor', 'borderWidth', 'borderStyle',
  'listStyleType', 'float', 'clear',
]);

const READER_MARKS: ReadonlySet<ReaderInlineMark> = new Set([
  'strong', 'emphasis', 'underline', 'strike', 'subscript', 'superscript', 'code', 'mark', 'small', 'big',
]);

function normalizeReaderStyle(raw: unknown): ReaderContentStyle | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const result: ReaderContentStyle = {};
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    if (!READER_STYLE_KEYS.has(rawKey as keyof ReaderContentStyle) || typeof rawValue !== 'string') continue;
    if (rawValue.length > 160 || /url\s*\(|expression\s*\(|javascript\s*:|var\s*\(/i.test(rawValue)) continue;
    result[rawKey as keyof ReaderContentStyle] = rawValue;
  }
  return Object.keys(result).length ? result : undefined;
}

function normalizeReaderInlineContent(raw: unknown): ReaderInlineContent[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): ReaderInlineContent[] => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Record<string, unknown>;
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      const marks = Array.isArray(candidate.marks)
        ? candidate.marks.filter((mark): mark is ReaderInlineMark => typeof mark === 'string' && READER_MARKS.has(mark as ReaderInlineMark))
        : [];
      const href = typeof candidate.href === 'string' && /^(https?:|mailto:|tel:|#)/i.test(candidate.href) && !candidate.href.startsWith('//')
        ? candidate.href
        : undefined;
      const style = normalizeReaderStyle(candidate.style);
      return [{
        type: 'text',
        text: candidate.text,
        marks,
        ...(style ? { style } : {}),
        ...(href ? { href } : {}),
        ...(typeof candidate.title === 'string' ? { title: candidate.title } : {}),
        ...(candidate.lineBreakBefore === true ? { lineBreakBefore: true } : {}),
      }];
    }
    if (candidate.type === 'image' && typeof candidate.src === 'string' && candidate.src.startsWith('data:image/')) {
      const style = normalizeReaderStyle(candidate.style);
      return [{
        type: 'image',
        src: candidate.src,
        alt: typeof candidate.alt === 'string' ? candidate.alt : '',
        ...(typeof candidate.title === 'string' ? { title: candidate.title } : {}),
        ...(style ? { style } : {}),
      }];
    }
    return [];
  });
}

function normalizeReaderBlocks(raw: unknown, paragraphCount: number): ReaderContentBlock[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const blockTypes = new Set(['paragraph', 'heading', 'blockquote', 'list-item', 'verse', 'pre', 'caption', 'table-row']);
  const blocks: ReaderContentBlock[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    if (candidate.type === 'paragraph' && typeof candidate.paragraphIndex === 'number'
      && Number.isInteger(candidate.paragraphIndex) && candidate.paragraphIndex >= 0 && candidate.paragraphIndex < paragraphCount
      && typeof candidate.blockType === 'string' && blockTypes.has(candidate.blockType)) {
      const content = normalizeReaderInlineContent(candidate.content);
      const anchorIds = Array.isArray(candidate.anchorIds)
        ? candidate.anchorIds.filter((anchor): anchor is string => typeof anchor === 'string' && anchor.length > 0)
        : [];
      const style = normalizeReaderStyle(candidate.style);
      const paragraph: ReaderParagraphBlock = {
        type: 'paragraph',
        paragraphIndex: candidate.paragraphIndex,
        blockType: candidate.blockType as ReaderParagraphBlock['blockType'],
        ...(typeof candidate.level === 'number' && Number.isInteger(candidate.level) ? { level: candidate.level } : {}),
        ...(typeof candidate.listMarker === 'string' ? { listMarker: candidate.listMarker } : {}),
        ...(anchorIds.length ? { anchorIds } : {}),
        ...(style ? { style } : {}),
        content,
      };
      blocks.push(paragraph);
    } else if ((candidate.type === 'image' || candidate.type === 'rule' || candidate.type === 'spacer')
      && typeof candidate.afterParagraphIndex === 'number' && Number.isInteger(candidate.afterParagraphIndex)
      && candidate.afterParagraphIndex >= 0 && candidate.afterParagraphIndex <= paragraphCount) {
      const anchorIds = Array.isArray(candidate.anchorIds) ? candidate.anchorIds.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
      if (candidate.type === 'image' && typeof candidate.src === 'string' && candidate.src.startsWith('data:image/')) {
        const style = normalizeReaderStyle(candidate.style);
        blocks.push({
          type: 'image',
          afterParagraphIndex: candidate.afterParagraphIndex,
          ...(anchorIds.length ? { anchorIds } : {}),
          src: candidate.src,
          alt: typeof candidate.alt === 'string' ? candidate.alt : '',
          ...(typeof candidate.title === 'string' ? { title: candidate.title } : {}),
          ...(style ? { style } : {}),
        });
      } else if (candidate.type === 'rule' || candidate.type === 'spacer') {
        const style = normalizeReaderStyle(candidate.style);
        blocks.push({
          type: candidate.type,
          afterParagraphIndex: candidate.afterParagraphIndex,
          ...(anchorIds.length ? { anchorIds } : {}),
          ...(style ? { style } : {}),
        });
      }
    }
  }
  return blocks;
}

function normalizeBook(raw: unknown): ImportedBook | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const candidate = raw as Partial<ImportedBook>;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    return null;
  }
  if (!Array.isArray(candidate.chapters)) {
    return null;
  }

  const normalizedChapters = candidate.chapters
    .map((chapter) => {
      const paragraphs = Array.isArray(chapter.paragraphs) ? chapter.paragraphs.filter((item): item is string => typeof item === 'string') : [];
      const readerBlocks = normalizeReaderBlocks(chapter.readerBlocks, paragraphs.length);
      return {
        title: typeof chapter.title === 'string' && chapter.title.length > 0 ? chapter.title : 'Chapter',
        paragraphs,
        ...(readerBlocks ? { readerBlocks } : {}),
        ...(chapter.titlePresentation === 'content' || chapter.titlePresentation === 'generated' || chapter.titlePresentation === 'continuation' ? { titlePresentation: chapter.titlePresentation } : {}),
        ...(typeof chapter.linear === 'boolean' ? { linear: chapter.linear } : {}),
      };
    })
    .filter((chapter) => chapter.paragraphs.length > 0 || chapter.readerBlocks?.some((block) => block.type === 'image'));

  const isSeedHitchhiker = candidate.id === 'seed-hitchhiker';
  const fallbackTitle = isSeedHitchhiker ? "The Hitchhiker's Guide to the Galaxy" : 'Untitled Book';
  const fallbackAuthor = isSeedHitchhiker ? 'Douglas Adams' : 'Unknown Author';

  return {
    id: candidate.id,
    title: typeof candidate.title === 'string' && candidate.title.length > 0 ? candidate.title : fallbackTitle,
    author: typeof candidate.author === 'string' && candidate.author.length > 0 ? candidate.author : fallbackAuthor,
    sourceType: candidate.sourceType === 'epub' || candidate.sourceType === 'fb2' || candidate.sourceType === 'pdf' ? candidate.sourceType : 'txt',
    createdAt: typeof candidate.createdAt === 'string' && candidate.createdAt.length > 0 ? candidate.createdAt : new Date().toISOString(),
    updatedAt: typeof candidate.updatedAt === 'string' && candidate.updatedAt.length > 0 ? candidate.updatedAt : new Date().toISOString(),
    currentChapter: normalizeChapterNumber(candidate.currentChapter, normalizedChapters.length),
    currentChapterProgress: normalizeChapterProgress(candidate.currentChapterProgress),
    chapters: normalizedChapters,
  };
}

function normalizeBooks(rawBooks: unknown[]): ImportedBook[] {
  const normalized: ImportedBook[] = [];
  for (const item of rawBooks) {
    const book = normalizeBook(item);
    if (book) {
      normalized.push(book);
    }
  }
  return normalized;
}

function loadFallbackBooks(): ImportedBook[] {
  const raw = localStorage.getItem(BOOKS_FALLBACK_STORAGE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return sortBooks(normalizeBooks(parsed));
  } catch (error) {
    console.warn('books-fallback-parse-failed', { error });
    return [];
  }
}

function saveFallbackBooks(books: ImportedBook[]): void {
  localStorage.setItem(BOOKS_FALLBACK_STORAGE_KEY, JSON.stringify(books));
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BOOKS_DB_NAME, BOOKS_DB_VERSION);
    request.onerror = () => reject(new Error('Opening IndexedDB for books failed.'));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BOOKS_STORE_NAME)) {
        db.createObjectStore(BOOKS_STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

async function withStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(BOOKS_STORE_NAME, mode);
    const store = tx.objectStore(BOOKS_STORE_NAME);
    const result = await operation(store);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('IndexedDB transaction failed.'));
      tx.onabort = () => reject(new Error('IndexedDB transaction aborted.'));
    });
    return result;
  } finally {
    db.close();
  }
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('IndexedDB request failed.'));
  });
}

export async function listBooks(): Promise<ImportedBook[]> {
  if (!isIndexedDbAvailable()) {
    return loadFallbackBooks();
  }

  try {
    const books = await withStore('readonly', async (store) => {
      const result = await requestToPromise(store.getAll() as IDBRequest<unknown[]>);
      return result;
    });
    return sortBooks(normalizeBooks(books));
  } catch (error) {
    console.warn('books-indexeddb-list-failed', { error });
    return loadFallbackBooks();
  }
}

export async function getBookById(id: string): Promise<ImportedBook | null> {
  if (!isIndexedDbAvailable()) {
    const books = loadFallbackBooks();
    return books.find((book) => book.id === id) ?? null;
  }

  try {
    return await withStore('readonly', async (store) => {
      const book = await requestToPromise(store.get(id) as IDBRequest<unknown>);
      return normalizeBook(book);
    });
  } catch (error) {
    console.warn('books-indexeddb-get-failed', { id, error });
    const books = loadFallbackBooks();
    return books.find((book) => book.id === id) ?? null;
  }
}

export async function upsertBook(book: ImportedBook): Promise<void> {
  const normalized = normalizeBook(book);
  if (!normalized) {
    throw new Error('Cannot upsert invalid book payload.');
  }

  if (!isIndexedDbAvailable()) {
    const books = loadFallbackBooks();
    const next = books.filter((item) => item.id !== normalized.id);
    next.push(normalized);
    saveFallbackBooks(sortBooks(next));
    return;
  }

  try {
    await withStore('readwrite', async (store) => {
      await requestToPromise(store.put(normalized));
      return undefined;
    });
  } catch (error) {
    console.warn('books-indexeddb-upsert-failed', { id: normalized.id, error });
    const books = loadFallbackBooks();
    const next = books.filter((item) => item.id !== normalized.id);
    next.push(normalized);
    saveFallbackBooks(sortBooks(next));
  }
}

export async function deleteBookById(id: string): Promise<void> {
  if (!isIndexedDbAvailable()) {
    const books = loadFallbackBooks();
    const next = books.filter((item) => item.id !== id);
    saveFallbackBooks(sortBooks(next));
    if (id === 'seed-hitchhiker') {
      localStorage.setItem(DISMISSED_SEED_BOOK_KEY, 'true');
    }
    return;
  }

  try {
    await withStore('readwrite', async (store) => {
      await requestToPromise(store.delete(id));
      return undefined;
    });
  } catch (error) {
    console.warn('books-indexeddb-delete-failed', { id, error });
    const books = loadFallbackBooks();
    const next = books.filter((item) => item.id !== id);
    saveFallbackBooks(sortBooks(next));
  }
  if (id === 'seed-hitchhiker') {
    localStorage.setItem(DISMISSED_SEED_BOOK_KEY, 'true');
  }
}

export async function seedBooksIfEmpty(seedBooks: ImportedBook[]): Promise<void> {
  if (localStorage.getItem(DISMISSED_SEED_BOOK_KEY) === 'true') {
    return;
  }
  const existing = await listBooks();
  if (existing.length > 0) {
    return;
  }
  for (const book of seedBooks) {
    await upsertBook(book);
  }
}
