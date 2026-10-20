import type { ImportedBook } from './types';

const HITCHHIKERS_EPUB_URL = 'data/hitchhikers_guide.epub';

function createFallbackSeedBook(nowIso: string): ImportedBook {
  return {
    id: 'seed-hitchhiker',
    title: "The Hitchhiker's Guide to the Galaxy",
    author: 'Douglas Adams',
    sourceType: 'epub',
    createdAt: nowIso,
    updatedAt: nowIso,
    currentChapter: 1,
    currentChapterProgress: 0,
    chapters: [
      {
        title: 'Chapter 1',
        paragraphs: ['Unable to load bundled book from data/hitchhikers_guide.epub.'],
      },
    ],
  };
}

export async function createSeedBook(): Promise<ImportedBook> {
  const nowIso = new Date().toISOString();

  try {
    const response = await fetch(`${import.meta.env.BASE_URL}${HITCHHIKERS_EPUB_URL}`);
    if (!response.ok) {
      throw new Error(`status=${response.status}`);
    }

    const { parseEpubBook } = await import('./epub-parser.js');
    const epub = await parseEpubBook(await response.arrayBuffer());

    return {
      id: 'seed-hitchhiker',
      title: epub.title,
      author: epub.author,
      sourceType: 'epub',
      createdAt: nowIso,
      updatedAt: nowIso,
      currentChapter: 1,
      currentChapterProgress: 0,
      chapters: epub.chapters.map((chapter) => ({ ...chapter, titlePresentation: 'generated' })),
      navigation: epub.navigation,
    };
  } catch (error) {
    console.error('seed-book-load-failed', { error });
    return createFallbackSeedBook(nowIso);
  }
}
