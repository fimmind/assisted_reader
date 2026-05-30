import type { BookLemmaHistogram } from './reader-analysis';

interface CachedBookLemmaHistogramEntry {
  histogram: BookLemmaHistogram;
  bookUpdatedAt: string;
  modelKey: string;
}

type CachedBookLemmaHistogramMap = Record<string, CachedBookLemmaHistogramEntry>;

const BOOK_LEMMA_HISTOGRAM_CACHE_KEY = 'easeword-book-lemma-histogram-cache-v1';

function isValidHistogram(value: unknown): value is BookLemmaHistogram {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const typed = value as Partial<BookLemmaHistogram>;
  if (typeof typed.totalTokenCount !== 'number' || !Number.isFinite(typed.totalTokenCount) || typed.totalTokenCount < 0) {
    return false;
  }
  if (!typed.nonProperLemmaCounts || typeof typed.nonProperLemmaCounts !== 'object') {
    return false;
  }
  const counts = Object.values(typed.nonProperLemmaCounts as Record<string, unknown>);
  for (const count of counts) {
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
      return false;
    }
  }
  return true;
}

function isValidCacheMap(value: unknown): value is CachedBookLemmaHistogramMap {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const entries = Object.values(value as Record<string, unknown>);
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    const typed = entry as Partial<CachedBookLemmaHistogramEntry>;
    if (typeof typed.bookUpdatedAt !== 'string') {
      return false;
    }
    if (typeof typed.modelKey !== 'string') {
      return false;
    }
    if (!isValidHistogram(typed.histogram)) {
      return false;
    }
  }
  return true;
}

function loadCacheMap(): CachedBookLemmaHistogramMap {
  const raw = localStorage.getItem(BOOK_LEMMA_HISTOGRAM_CACHE_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isValidCacheMap(parsed)) {
      return {};
    }
    return parsed;
  } catch (error) {
    console.warn('book-lemma-histogram-cache-parse-failed', { error });
    return {};
  }
}

function saveCacheMap(cacheMap: CachedBookLemmaHistogramMap): void {
  localStorage.setItem(BOOK_LEMMA_HISTOGRAM_CACHE_KEY, JSON.stringify(cacheMap));
}

export function getCachedBookLemmaHistogram(
  bookId: string,
  bookUpdatedAt: string,
  modelKey: string,
): BookLemmaHistogram | null {
  const cacheMap = loadCacheMap();
  const entry = cacheMap[bookId];
  if (!entry) {
    return null;
  }
  if (entry.bookUpdatedAt !== bookUpdatedAt) {
    return null;
  }
  if (entry.modelKey !== modelKey) {
    return null;
  }
  return entry.histogram;
}

export function saveCachedBookLemmaHistogram(
  bookId: string,
  bookUpdatedAt: string,
  modelKey: string,
  histogram: BookLemmaHistogram,
): void {
  const cacheMap = loadCacheMap();
  cacheMap[bookId] = {
    histogram,
    bookUpdatedAt,
    modelKey,
  };
  saveCacheMap(cacheMap);
}
