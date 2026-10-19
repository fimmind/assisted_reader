import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { deleteBookById, getBookById, listBooks, upsertBook } from '../src/core/books-store.js';
import { READING_PROGRESS_STORAGE_KEY } from '../src/core/constants.js';
import { createProfile, deleteProfile, getActiveProfile, loadProfileState, resetProfileObservations, setActiveProfile } from '../src/core/profile-store.js';
import { saveBookReadingProgress, withBookReadingProgress } from '../src/core/reading-progress-store.js';
import { createReaderBookmark, listReaderBookmarks, renameReaderBookmark } from '../src/core/reader-bookmarks.js';
import type { ImportedBook } from '../src/core/types.js';

const book: ImportedBook = {
  id: 'shared-book', title: 'Shared Book', author: 'Author', sourceType: 'txt',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  currentChapter: 2, currentChapterProgress: 0.4,
  chapters: [
    { title: 'First', paragraphs: ['First chapter.'] },
    { title: 'Second', paragraphs: ['Second chapter.'] },
    { title: 'Third', paragraphs: ['Third chapter.'] },
  ],
};

test('shared books retain independent positions across profile switches, reloads, resets, and deletion', async () => {
  const dom = new JSDOM('', { url: 'https://reader.test/' });
  globalThis.localStorage = dom.window.localStorage;
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.CustomEvent = dom.window.CustomEvent;
  try {
    await upsertBook(book);
    const firstId = getActiveProfile(loadProfileState()).id;
    const firstBookmark = createReaderBookmark(firstId, book.id, { chapterIndex: 0, blockIndex: 0, textOffset: 2 }, 'Opening');
    assert.deepEqual(listReaderBookmarks(firstId, book.id), [firstBookmark]);
    const legacyView = withBookReadingProgress(book, firstId);
    assert.equal(legacyView.currentChapter, 2);
    assert.equal(legacyView.currentChapterProgress, 0.4);

    createProfile('Second reader');
    const secondId = getActiveProfile(loadProfileState()).id;
    assert.deepEqual(listReaderBookmarks(secondId, book.id), []);
    const secondBookmark = createReaderBookmark(secondId, book.id, { chapterIndex: 1, blockIndex: 0, textOffset: 4 }, 'Second chapter');
    assert.deepEqual(listReaderBookmarks(secondId, book.id), [secondBookmark]);
    const renamedBookmark = renameReaderBookmark(secondId, book.id, secondBookmark.id, '  Renamed title  ');
    assert.deepEqual(renamedBookmark, { ...secondBookmark, label: 'Renamed title' });
    assert.deepEqual(listReaderBookmarks(secondId, book.id), [renamedBookmark]);
    assert.deepEqual(listReaderBookmarks(firstId, book.id), [firstBookmark]);
    assert.throws(() => renameReaderBookmark(secondId, book.id, secondBookmark.id, '   '), RangeError);
    assert.throws(() => renameReaderBookmark(secondId, book.id, 'missing-bookmark', 'Title'), /missing bookmark/);
    const freshView = withBookReadingProgress(book, secondId);
    assert.equal(freshView.currentChapter, 1);
    assert.equal(freshView.currentChapterProgress, 0);
    assert.equal((await listBooks()).length, 1);
    assert.deepEqual(freshView.chapters, legacyView.chapters);

    saveBookReadingProgress(secondId, book.id, { currentChapter: 3, currentChapterProgress: 0.7 });
    setActiveProfile(firstId);
    const storedBook = await getBookById(book.id);
    assert.ok(storedBook);
    assert.equal(withBookReadingProgress(storedBook, firstId).currentChapterProgress, 0.4);
    saveBookReadingProgress(firstId, book.id, { currentChapter: 2, currentChapterProgress: 0.9 });

    setActiveProfile(secondId);
    assert.equal(withBookReadingProgress(storedBook, secondId).currentChapter, 3);
    assert.equal(withBookReadingProgress(storedBook, secondId).currentChapterProgress, 0.7);
    assert.deepEqual(await getBookById(book.id), book);
    assert.equal(book.currentChapterProgress, 0.4);

    const serialized = localStorage.getItem(READING_PROGRESS_STORAGE_KEY);
    assert.ok(serialized);
    localStorage.setItem(READING_PROGRESS_STORAGE_KEY, serialized);
    const reloadedId = getActiveProfile(loadProfileState()).id;
    assert.equal(withBookReadingProgress(storedBook, reloadedId).currentChapterProgress, 0.7);
    saveBookReadingProgress(firstId, book.id, {
      currentChapter: 1,
      currentChapterProgress: 0.01,
      location: { chapterIndex: 99, blockIndex: 99, textOffset: 99 },
      pagePosition: { layoutKey: 'layout-signature', pageIndex: 4 },
    });
    const canonicalReload = withBookReadingProgress(storedBook, firstId);
    assert.deepEqual(canonicalReload.location, { chapterIndex: 2, blockIndex: 0, textOffset: 14 });
    assert.deepEqual(canonicalReload.pagePosition, { layoutKey: 'layout-signature', pageIndex: 4 });
    assert.equal(canonicalReload.currentChapter, 3);
    assert.equal(canonicalReload.currentChapterProgress, 1);
    assert.equal(withBookReadingProgress(storedBook, secondId).currentChapter, 3);
    assert.equal(withBookReadingProgress(storedBook, secondId).currentChapterProgress, 0.7);
    resetProfileObservations(secondId);
    assert.equal(withBookReadingProgress(storedBook, secondId).currentChapterProgress, 0.7);

    deleteProfile(secondId);
    assert.deepEqual(listReaderBookmarks(secondId, book.id), []);
    assert.deepEqual(listReaderBookmarks(firstId, book.id), [firstBookmark]);
    assert.equal(getActiveProfile(loadProfileState()).id, firstId);
    assert.equal(withBookReadingProgress(storedBook, secondId).currentChapterProgress, 0);
    assert.equal(withBookReadingProgress(storedBook, firstId).currentChapterProgress, 1);
    createProfile('Third reader');
    const thirdId = getActiveProfile(loadProfileState()).id;
    assert.equal(withBookReadingProgress(storedBook, thirdId).currentChapter, 1);
    saveBookReadingProgress(thirdId, book.id, { currentChapter: 1, currentChapterProgress: 0.2 });
    deleteProfile(firstId);
    assert.equal(withBookReadingProgress(storedBook, firstId).currentChapterProgress, 0);
    assert.equal(withBookReadingProgress(storedBook, thirdId).currentChapterProgress, 0.2);

    await deleteBookById(book.id);
    assert.equal(await getBookById(book.id), null);
    assert.deepEqual(listReaderBookmarks(firstId, book.id), []);
    assert.deepEqual(listReaderBookmarks(thirdId, book.id), []);
    await upsertBook({ ...book, currentChapter: 1, currentChapterProgress: 0 });
    const reimportedBook = await getBookById(book.id);
    assert.ok(reimportedBook);
    assert.equal(withBookReadingProgress(reimportedBook, firstId).currentChapterProgress, 0);
    assert.equal(withBookReadingProgress(reimportedBook, thirdId).currentChapterProgress, 0);

    assert.throws(() => saveBookReadingProgress(firstId, book.id, {
      currentChapter: 0, currentChapterProgress: 0,
    }), RangeError);
    assert.throws(() => saveBookReadingProgress(firstId, book.id, {
      currentChapter: 1, currentChapterProgress: Number.NaN,
    }), RangeError);
    assert.throws(() => saveBookReadingProgress(firstId, book.id, {
      currentChapter: 1,
      currentChapterProgress: 0,
      pagePosition: { layoutKey: '', pageIndex: -1 },
    }), RangeError);
    localStorage.setItem(READING_PROGRESS_STORAGE_KEY, '{broken');
    assert.throws(() => loadProfileState(), /Saved reading progress is invalid JSON/);
    localStorage.setItem(READING_PROGRESS_STORAGE_KEY, serialized);
    assert.equal(withBookReadingProgress(storedBook, firstId).currentChapterProgress, 0.9);
  } finally {
    dom.window.close();
  }
});
