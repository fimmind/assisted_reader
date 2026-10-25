import type { ImportedBook } from './types';

const HITCHHIKERS_EPUB_URL = 'data/hitchhikers_guide.epub';

export async function createSeedBook(): Promise<ImportedBook> {
  const nowIso = new Date().toISOString();
  const url = `${import.meta.env.BASE_URL}${HITCHHIKERS_EPUB_URL}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Bundled EPUB request failed: url=${url} status=${response.status} body=${await response.text()}`);
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
    throw new Error(`Unable to load bundled EPUB: url=${url}`, { cause: error });
  }
}
