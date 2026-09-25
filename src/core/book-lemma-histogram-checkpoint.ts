import type { BookLemmaHistogram, BookLemmaHistogramSegment } from './reader-analysis';

type StoredSegment = BookLemmaHistogramSegment & {
  key: string;
  bookId: string;
  contentKey: string;
  modelKey: string;
  analysisVersion: number;
};

const DATABASE_NAME = 'easeword-book-lemma-histogram-checkpoints-v1';
const STORE_NAME = 'segments';
const COMPLETED_STORE_NAME = 'completed';
const ANALYSIS_VERSION = 1;

interface CompletedHistogram {
  bookId: string;
  contentKey: string;
  modelKey: string;
  analysisVersion: number;
  histogram: BookLemmaHistogram;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onerror = () => reject(new Error(`Could not open histogram checkpoint database: name=${DATABASE_NAME} error=${request.error?.message}`));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
      store.createIndex('bookId', 'bookId');
      store.createIndex('bookChapterKind', ['bookId', 'chapterIndex', 'kind']);
      request.result.createObjectStore(COMPLETED_STORE_NAME, { keyPath: 'bookId' });
    };
  });
}

function requestResult<T>(request: IDBRequest<T>, context: string): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(`Histogram checkpoint request failed: context=${context} error=${request.error?.message}`));
  });
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(storeName, mode);
    const completed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error(`Histogram checkpoint transaction failed: error=${transaction.error?.message}`));
      transaction.onabort = () => reject(new Error(`Histogram checkpoint transaction aborted: error=${transaction.error?.message}`));
    });
    const result = await operation(transaction.objectStore(storeName));
    await completed;
    return result;
  } finally {
    database.close();
  }
}

function isStoredSegment(value: unknown): value is StoredSegment {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const segment = value as Partial<StoredSegment> & {
    startParagraphIndex?: number;
    endParagraphIndex?: number;
  };
  if (typeof segment.key !== 'string' || typeof segment.bookId !== 'string'
    || typeof segment.contentKey !== 'string' || typeof segment.modelKey !== 'string'
    || typeof segment.analysisVersion !== 'number' || !Number.isInteger(segment.chapterIndex)
    || (segment.chapterIndex ?? -1) < 0) {
    return false;
  }
  if (segment.kind === 'lexicon') {
    return Array.isArray(segment.properLexicon)
      && segment.properLexicon.every((lemma) => typeof lemma === 'string');
  }
  const startParagraphIndex = segment.startParagraphIndex;
  const endParagraphIndex = segment.endParagraphIndex;
  if (typeof startParagraphIndex !== 'number' || typeof endParagraphIndex !== 'number'
    || !Number.isInteger(startParagraphIndex) || !Number.isInteger(endParagraphIndex)
    || startParagraphIndex < 0 || endParagraphIndex <= startParagraphIndex) {
    return false;
  }
  if (segment.kind === 'tags') {
    return Array.isArray(segment.taggedByParagraph)
      && segment.taggedByParagraph.length === endParagraphIndex - startParagraphIndex
      && segment.taggedByParagraph.every((paragraph) => Array.isArray(paragraph)
        && paragraph.every((sentence) => typeof sentence.text === 'string'
          && Array.isArray(sentence.terms)
          && sentence.terms.every((term) => typeof term.raw === 'string'
            && typeof term.normalized === 'string'
            && typeof term.sentenceInitial === 'boolean'
            && term.tags instanceof Set)));
  }
  if (segment.kind === 'counts') {
    return isValidHistogram(segment.histogram);
  }
  return false;
}

function isValidHistogram(value: unknown): value is BookLemmaHistogram {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const histogram = value as Partial<BookLemmaHistogram>;
  return typeof histogram.totalTokenCount === 'number'
    && Number.isFinite(histogram.totalTokenCount)
    && histogram.totalTokenCount >= 0
    && !!histogram.nonProperLemmaCounts
    && typeof histogram.nonProperLemmaCounts === 'object'
    && Object.values(histogram.nonProperLemmaCounts).every((count) =>
      typeof count === 'number' && Number.isFinite(count) && count >= 0);
}

export async function loadCompletedBookLemmaHistogram(
  bookId: string,
  contentKey: string,
  modelKey: string,
): Promise<BookLemmaHistogram | null> {
  const value = await withStore(COMPLETED_STORE_NAME, 'readonly', (store) =>
    requestResult(store.get(bookId) as IDBRequest<unknown>, `load completed histogram bookId=${bookId}`));
  if (value === undefined) {
    return null;
  }
  if (!value || typeof value !== 'object') {
    throw new TypeError(`Invalid completed book histogram: bookId=${bookId}`);
  }
  const completed = value as Partial<CompletedHistogram>;
  if (completed.bookId !== bookId || typeof completed.contentKey !== 'string'
    || typeof completed.modelKey !== 'string' || typeof completed.analysisVersion !== 'number'
    || !isValidHistogram(completed.histogram)) {
    throw new TypeError(`Invalid completed book histogram: bookId=${bookId}`);
  }
  if (completed.contentKey !== contentKey || completed.modelKey !== modelKey
    || completed.analysisVersion !== ANALYSIS_VERSION) {
    await withStore(COMPLETED_STORE_NAME, 'readwrite', async (store) => {
      await requestResult(store.delete(bookId), `delete stale completed histogram bookId=${bookId}`);
    });
    return null;
  }
  return completed.histogram;
}

export async function completeBookLemmaHistogram(
  bookId: string,
  contentKey: string,
  modelKey: string,
  histogram: BookLemmaHistogram,
): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([STORE_NAME, COMPLETED_STORE_NAME], 'readwrite');
    const completed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error(`Completing book histogram failed: bookId=${bookId} error=${transaction.error?.message}`));
      transaction.onabort = () => reject(new Error(`Completing book histogram aborted: bookId=${bookId} error=${transaction.error?.message}`));
    });
    const segmentStore = transaction.objectStore(STORE_NAME);
    const keys = await requestResult(segmentStore.index('bookId').getAllKeys(bookId), `list completed checkpoints bookId=${bookId}`);
    for (const key of keys) {
      segmentStore.delete(key);
    }
    transaction.objectStore(COMPLETED_STORE_NAME).put({
      bookId,
      contentKey,
      modelKey,
      analysisVersion: ANALYSIS_VERSION,
      histogram,
    } satisfies CompletedHistogram);
    await completed;
  } finally {
    database.close();
  }
}

export async function clearBookLemmaHistogramCheckpoints(bookId: string): Promise<void> {
  await withStore(STORE_NAME, 'readwrite', async (store) => {
    const keys = await requestResult(store.index('bookId').getAllKeys(bookId), `list book checkpoints bookId=${bookId}`);
    for (const key of keys) {
      store.delete(key);
    }
  });
}

export async function loadBookLemmaHistogramCheckpoints(
  bookId: string,
  contentKey: string,
  modelKey: string,
): Promise<BookLemmaHistogramSegment[]> {
  const values = await withStore(STORE_NAME, 'readonly', (store) =>
    requestResult(store.index('bookId').getAll(bookId) as IDBRequest<unknown[]>, `load book checkpoints bookId=${bookId}`));
  if (values.length === 0) {
    return [];
  }
  if (!values.every(isStoredSegment)) {
    throw new TypeError(`Invalid book histogram checkpoint: bookId=${bookId}`);
  }
  const segments = values as StoredSegment[];
  if (segments.some((segment) => segment.contentKey !== contentKey
    || segment.modelKey !== modelKey || segment.analysisVersion !== ANALYSIS_VERSION)) {
    await clearBookLemmaHistogramCheckpoints(bookId);
    return [];
  }
  return segments;
}

export async function saveBookLemmaHistogramCheckpoint(
  bookId: string,
  contentKey: string,
  modelKey: string,
  segment: BookLemmaHistogramSegment,
): Promise<void> {
  const startParagraphIndex = segment.kind === 'lexicon' ? 0 : segment.startParagraphIndex;
  const key = JSON.stringify([bookId, segment.chapterIndex, segment.kind, startParagraphIndex]);
  const stored: StoredSegment = {
    ...segment,
    key,
    bookId,
    contentKey,
    modelKey,
    analysisVersion: ANALYSIS_VERSION,
  };
  await withStore(STORE_NAME, 'readwrite', async (store) => {
    await requestResult(store.put(stored), `save book checkpoint bookId=${bookId} chapter=${segment.chapterIndex} kind=${segment.kind} start=${startParagraphIndex}`);
  });
}

export async function clearTaggedBookChapterCheckpoints(
  bookId: string,
  chapterIndex: number,
): Promise<void> {
  await withStore(STORE_NAME, 'readwrite', async (store) => {
    const index = store.index('bookChapterKind');
    const [tagKeys, lexiconKeys] = await Promise.all([
      requestResult(index.getAllKeys([bookId, chapterIndex, 'tags']), `list tag checkpoints bookId=${bookId} chapter=${chapterIndex}`),
      requestResult(index.getAllKeys([bookId, chapterIndex, 'lexicon']), `list lexicon checkpoint bookId=${bookId} chapter=${chapterIndex}`),
    ]);
    for (const key of [...tagKeys, ...lexiconKeys]) {
      store.delete(key);
    }
  });
}
