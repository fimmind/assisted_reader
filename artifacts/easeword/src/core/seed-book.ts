import { parseTxtBook } from './book-parser';
import type { ImportedBook } from './types';

const HITCHHIKERS_TXT_URL = 'data/hitchhikers_guide.txt';

function createFallbackSeedBook(nowIso: string): ImportedBook {
  return {
    id: 'seed-hitchhiker',
    title: "The Hitchhiker's Guide to the Galaxy",
    author: 'Douglas Adams',
    sourceType: 'txt',
    createdAt: nowIso,
    updatedAt: nowIso,
    currentChapter: 1,
    chapters: [
      {
        title: 'Chapter 1',
        paragraphs: ['Unable to load seeded book text from data/hitchhikers_guide.txt.'],
      },
    ],
  };
}

export async function createSeedBook(): Promise<ImportedBook> {
  const nowIso = new Date().toISOString();

  try {
    const response = await fetch(`${import.meta.env.BASE_URL}${HITCHHIKERS_TXT_URL}`);
    if (!response.ok) {
      throw new Error(`status=${response.status}`);
    }

    const text = await response.text();
    const chapters = parseTxtBook(text);
    if (chapters.length === 0) {
      throw new Error('no chapters parsed from seeded text');
    }

    return {
      id: 'seed-hitchhiker',
      title: "The Hitchhiker's Guide to the Galaxy",
      author: 'Douglas Adams',
      sourceType: 'txt',
      createdAt: nowIso,
      updatedAt: nowIso,
      currentChapter: 1,
      chapters,
    };
  } catch (error) {
    console.error('seed-book-load-failed', { error });
    return createFallbackSeedBook(nowIso);
  }
}
