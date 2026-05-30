import type { BookLemmaHistogram } from './reader-analysis';

const HITCHHIKER_BOOK_ID = 'seed-hitchhiker';
const HITCHHIKER_HISTOGRAM_PATH = 'data/seed-hitchhiker-lemma-histogram.json';

let hitchhikerHistogramPromise: Promise<BookLemmaHistogram | null> | null = null;

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
  for (const count of Object.values(typed.nonProperLemmaCounts as Record<string, unknown>)) {
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
      return false;
    }
  }
  return true;
}

async function loadHitchhikerHistogram(): Promise<BookLemmaHistogram | null> {
  if (hitchhikerHistogramPromise) {
    return hitchhikerHistogramPromise;
  }

  hitchhikerHistogramPromise = (async () => {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}${HITCHHIKER_HISTOGRAM_PATH}`);
      if (!response.ok) {
        throw new Error(`Bundled histogram load failed: status=${response.status}`);
      }
      const parsed: unknown = await response.json();
      if (!isValidHistogram(parsed)) {
        throw new Error('Bundled histogram payload is invalid.');
      }
      return parsed;
    } catch (error) {
      console.warn('bundled-hitchhiker-histogram-load-failed', { error });
      return null;
    }
  })();

  return hitchhikerHistogramPromise;
}

export async function loadBundledBookLemmaHistogram(bookId: string): Promise<BookLemmaHistogram | null> {
  if (bookId !== HITCHHIKER_BOOK_ID) {
    return null;
  }
  return loadHitchhikerHistogram();
}
