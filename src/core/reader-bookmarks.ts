import type { ReaderBookmark, ReaderLocation } from './types.js';
import { createId } from './math.js';

const READER_BOOKMARKS_STORAGE_KEY = 'easeword-reader-bookmarks-v1';

interface ReaderBookmarkState {
  schemaVersion: 1;
  byProfile: Record<string, Record<string, ReaderBookmark[]>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isReaderLocation(value: unknown): value is ReaderLocation {
  return isRecord(value)
    && Number.isInteger(value.chapterIndex) && (value.chapterIndex as number) >= 0
    && Number.isInteger(value.blockIndex) && (value.blockIndex as number) >= 0
    && Number.isInteger(value.textOffset) && (value.textOffset as number) >= 0;
}

function isReaderBookmark(value: unknown): value is ReaderBookmark {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.bookId === 'string'
    && isReaderLocation(value.location)
    && typeof value.label === 'string'
    && typeof value.createdAt === 'string';
}

function loadState(): ReaderBookmarkState {
  const raw = localStorage.getItem(READER_BOOKMARKS_STORAGE_KEY);
  if (raw === null) return { schemaVersion: 1, byProfile: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SyntaxError(`Saved reader bookmarks have invalid JSON in ${READER_BOOKMARKS_STORAGE_KEY}: ${error.message}`);
    }
    throw error;
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.byProfile)) {
    throw new Error(`Saved reader bookmarks have an invalid structure in ${READER_BOOKMARKS_STORAGE_KEY}.`);
  }
  for (const [profileId, books] of Object.entries(parsed.byProfile)) {
    if (!isRecord(books)) throw new Error(`Saved bookmarks are invalid for profile=${profileId}.`);
    for (const [bookId, bookmarks] of Object.entries(books)) {
      if (!Array.isArray(bookmarks) || !bookmarks.every(isReaderBookmark)
        || bookmarks.some((bookmark) => bookmark.bookId !== bookId)) {
        throw new Error(`Saved bookmarks are invalid for profile=${profileId} book=${bookId}.`);
      }
    }
  }
  return parsed as unknown as ReaderBookmarkState;
}

function saveState(state: ReaderBookmarkState): void {
  localStorage.setItem(READER_BOOKMARKS_STORAGE_KEY, JSON.stringify(state));
}

/** List bookmarks for one profile and book in creation order. */
export function listReaderBookmarks(profileId: string, bookId: string): ReaderBookmark[] {
  return [...(loadState().byProfile[profileId]?.[bookId] ?? [])];
}

/** Create and store a profile-scoped bookmark. */
export function createReaderBookmark(
  profileId: string,
  bookId: string,
  location: ReaderLocation,
  label: string,
): ReaderBookmark {
  if (!isReaderLocation(location)) throw new RangeError('Bookmark location must contain non-negative integer indexes and offset.');
  const bookmark: ReaderBookmark = {
    id: createId('bookmark'),
    bookId,
    location: { ...location },
    label: label.trim(),
    createdAt: new Date().toISOString(),
  };
  const state = loadState();
  const profileBooks = state.byProfile[profileId] ?? {};
  saveState({
    ...state,
    byProfile: {
      ...state.byProfile,
      [profileId]: { ...profileBooks, [bookId]: [...(profileBooks[bookId] ?? []), bookmark] },
    },
  });
  return bookmark;
}

/** Remove one bookmark without affecting another profile's saved locations. */
export function deleteReaderBookmark(profileId: string, bookId: string, bookmarkId: string): void {
  const state = loadState();
  const bookmarks = state.byProfile[profileId]?.[bookId] ?? [];
  saveState({
    ...state,
    byProfile: {
      ...state.byProfile,
      [profileId]: { ...state.byProfile[profileId], [bookId]: bookmarks.filter((bookmark) => bookmark.id !== bookmarkId) },
    },
  });
}

/** Delete all bookmarks belonging to a deleted profile. */
export function clearReaderBookmarksForProfile(profileId: string): void {
  const state = loadState();
  const byProfile = Object.fromEntries(Object.entries(state.byProfile).filter(([id]) => id !== profileId));
  saveState({ ...state, byProfile });
}

/** Delete bookmarks for a book across every profile when the book is removed. */
export function clearReaderBookmarksForBook(bookId: string): void {
  const state = loadState();
  const byProfile = Object.fromEntries(Object.entries(state.byProfile).map(([profileId, books]) => [
    profileId,
    Object.fromEntries(Object.entries(books).filter(([id]) => id !== bookId)),
  ]));
  saveState({ ...state, byProfile });
}
