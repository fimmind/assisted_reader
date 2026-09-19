import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { pdfPageParagraphs } from './pdf-text';
import type { BookChapter } from './types';

// Vite emits the matching worker locally, including under a deployment base path.
GlobalWorkerOptions.workerSrc = workerUrl;

export async function parsePdfBook(buffer: ArrayBuffer): Promise<BookChapter[]> {
  const loadingTask = getDocument({ data: new Uint8Array(buffer) });
  try {
    const pdf = await loadingTask.promise;
    const paragraphs: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        // Keep page boundaries as paragraph breaks, not reader chapter breaks.
        for (const paragraph of pdfPageParagraphs(content.items)) paragraphs.push(paragraph);
      } finally {
        page.cleanup();
      }
    }
    if (paragraphs.length === 0) {
      throw new Error('No selectable text found in this PDF. Scanned PDFs are not supported yet.');
    }
    return [{ title: 'Chapter 1', paragraphs }];
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException') {
      throw new Error('This PDF is password-protected. Please import an unlocked copy.');
    }
    const reason = error instanceof Error ? error.message : 'Unknown PDF error.';
    throw new Error(`Could not import PDF: ${reason}`);
  } finally {
    await loadingTask.destroy();
  }
}
