import { BOOKS_DB_NAME, BOOKS_DB_VERSION, BOOKS_FALLBACK_STORAGE_KEY, BOOKS_STORE_NAME } from './constants';
import type { ImportedBook } from './types';

function isIndexedDbAvailable(): boolean {
  return typeof window !== 'undefined' && 'indexedDB' in window;
}

function sortBooks(books: ImportedBook[]): ImportedBook[] {
  return [...books].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function loadFallbackBooks(): ImportedBook[] {
  const raw = localStorage.getItem(BOOKS_FALLBACK_STORAGE_KEY);
  if (!raw) {
    return [];
  }
  try {
    return sortBooks(JSON.parse(raw) as ImportedBook[]);
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
      const result = await requestToPromise(store.getAll() as IDBRequest<ImportedBook[]>);
      return result;
    });
    return sortBooks(books);
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
      const book = await requestToPromise(store.get(id) as IDBRequest<ImportedBook | undefined>);
      return book ?? null;
    });
  } catch (error) {
    console.warn('books-indexeddb-get-failed', { id, error });
    const books = loadFallbackBooks();
    return books.find((book) => book.id === id) ?? null;
  }
}

export async function upsertBook(book: ImportedBook): Promise<void> {
  if (!isIndexedDbAvailable()) {
    const books = loadFallbackBooks();
    const next = books.filter((item) => item.id !== book.id);
    next.push(book);
    saveFallbackBooks(sortBooks(next));
    return;
  }

  try {
    await withStore('readwrite', async (store) => {
      await requestToPromise(store.put(book));
      return undefined;
    });
  } catch (error) {
    console.warn('books-indexeddb-upsert-failed', { id: book.id, error });
    const books = loadFallbackBooks();
    const next = books.filter((item) => item.id !== book.id);
    next.push(book);
    saveFallbackBooks(sortBooks(next));
  }
}

export async function deleteBookById(id: string): Promise<void> {
  if (!isIndexedDbAvailable()) {
    const books = loadFallbackBooks();
    const next = books.filter((item) => item.id !== id);
    saveFallbackBooks(sortBooks(next));
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
}

export async function seedBooksIfEmpty(seedBooks: ImportedBook[]): Promise<void> {
  const existing = await listBooks();
  if (existing.length > 0) {
    return;
  }
  for (const book of seedBooks) {
    await upsertBook(book);
  }
}
