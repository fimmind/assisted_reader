import { READING_PROGRESS_STORAGE_KEY } from './constants.js';
import { clearReaderBookmarksForBook, clearReaderBookmarksForProfile } from './reader-bookmarks.js';
import { chapterProgressAtLocation, resolveReaderLocation } from './reader-location.js';
import type { BookReadingProgress, ImportedBook, ReaderLocation } from './types.js';

interface ReadingProgressState {
  schemaVersion: 1;
  legacyProfileId: string | null;
  byProfile: Record<string, Record<string, BookReadingProgress>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBookReadingProgress(value: unknown): value is BookReadingProgress {
  return isRecord(value)
    && typeof value.currentChapter === 'number'
    && Number.isInteger(value.currentChapter) && value.currentChapter >= 1
    && typeof value.currentChapterProgress === 'number'
    && Number.isFinite(value.currentChapterProgress)
    && value.currentChapterProgress >= 0 && value.currentChapterProgress <= 1
    && (value.location === undefined || isReaderLocation(value.location));
}

function isReaderLocation(value: unknown): value is ReaderLocation {
  return isRecord(value)
    && Number.isInteger(value.chapterIndex) && (value.chapterIndex as number) >= 0
    && Number.isInteger(value.blockIndex) && (value.blockIndex as number) >= 0
    && Number.isInteger(value.textOffset) && (value.textOffset as number) >= 0;
}

function loadReadingProgressState(): ReadingProgressState | null {
  const raw = localStorage.getItem(READING_PROGRESS_STORAGE_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SyntaxError(`Saved reading progress is invalid JSON in ${READING_PROGRESS_STORAGE_KEY}: ${error.message}`);
    }
    throw error;
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1
    || (parsed.legacyProfileId !== null && typeof parsed.legacyProfileId !== 'string')
    || !isRecord(parsed.byProfile)) {
    throw new Error(`Saved reading progress has an invalid structure in ${READING_PROGRESS_STORAGE_KEY}.`);
  }
  for (const [profileId, books] of Object.entries(parsed.byProfile)) {
    if (!isRecord(books)) throw new Error(`Saved reading progress is invalid for profile=${profileId}.`);
    for (const [bookId, progress] of Object.entries(books)) {
      if (!isBookReadingProgress(progress)) {
        throw new Error(`Saved reading position is invalid for profile=${profileId} book=${bookId}.`);
      }
    }
  }
  return parsed as unknown as ReadingProgressState;
}

function saveReadingProgressState(state: ReadingProgressState): void {
  localStorage.setItem(READING_PROGRESS_STORAGE_KEY, JSON.stringify(state));
}

function requireReadingProgressState(): ReadingProgressState {
  const state = loadReadingProgressState();
  if (!state) throw new Error('Load a profile before accessing its reading progress.');
  return state;
}

/** Assign previously shared book positions to the profile active when this storage is first initialized. */
export function initializeReadingProgress(profileId: string): void {
  if (loadReadingProgressState()) return;
  saveReadingProgressState({ schemaVersion: 1, legacyProfileId: profileId, byProfile: {} });
}

/** Shared book fields retain legacy positions; all subsequent progress is stored separately per profile. */
export function withBookReadingProgress(book: ImportedBook, profileId: string): ImportedBook {
  const state = requireReadingProgressState();
  const progress = state.byProfile[profileId]?.[book.id];
  const position = progress ?? (state.legacyProfileId === profileId
    ? { currentChapter: book.currentChapter, currentChapterProgress: book.currentChapterProgress }
    : { currentChapter: 1, currentChapterProgress: 0 });
  if (!progress?.location) {
    return {
      ...book,
      currentChapter: Math.max(1, Math.min(position.currentChapter, Math.max(1, book.chapters.length))),
      currentChapterProgress: position.currentChapterProgress,
      location: undefined,
    };
  }
  const location = resolveReaderLocation(book, progress.location);
  const chapter = book.chapters[location.chapterIndex];
  const chapterProgress = chapter ? chapterProgressAtLocation(chapter, location.blockIndex, location.textOffset) : 0;
  return {
    ...book,
    currentChapter: location.chapterIndex + 1,
    currentChapterProgress: chapterProgress,
    location,
  };
}

export function saveBookReadingProgress(profileId: string, bookId: string, progress: BookReadingProgress): void {
  if (!isBookReadingProgress(progress)) {
    throw new RangeError(`Cannot save an invalid reading position for profile=${profileId} book=${bookId}.`);
  }
  const state = requireReadingProgressState();
  saveReadingProgressState({
    ...state,
    byProfile: {
      ...state.byProfile,
      [profileId]: {
        ...state.byProfile[profileId],
        [bookId]: {
          currentChapter: progress.currentChapter,
          currentChapterProgress: progress.currentChapterProgress,
          ...(progress.location ? { location: progress.location } : {}),
        },
      },
    },
  });
}

export function clearReadingProgressForProfile(profileId: string): void {
  clearReaderBookmarksForProfile(profileId);
  const state = loadReadingProgressState();
  if (!state) return;
  saveReadingProgressState({
    ...state,
    legacyProfileId: state.legacyProfileId === profileId ? null : state.legacyProfileId,
    byProfile: Object.fromEntries(Object.entries(state.byProfile).filter(([id]) => id !== profileId)),
  });
}

export function clearReadingProgressForBook(bookId: string): void {
  clearReaderBookmarksForBook(bookId);
  const state = loadReadingProgressState();
  if (!state) return;
  saveReadingProgressState({
    ...state,
    byProfile: Object.fromEntries(Object.entries(state.byProfile).map(([profileId, books]) => [
      profileId,
      Object.fromEntries(Object.entries(books).filter(([id]) => id !== bookId)),
    ])),
  });
}
