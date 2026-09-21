import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { pdfDocumentParagraphs, pdfTextLines } from './pdf-text';
import type { PdfTextPage } from './pdf-text';
import type { BookChapter } from './types';

// Vite emits the matching worker locally, including under a deployment base path.
GlobalWorkerOptions.workerSrc = workerUrl;

export async function parsePdfBook(buffer: ArrayBuffer): Promise<BookChapter[]> {
  const loadingTask = getDocument({ data: new Uint8Array(buffer) });
  try {
    const pdf = await loadingTask.promise;
    const pages: PdfTextPage[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const [x, y, right, top] = page.view;
        pages.push({
          lines: pdfTextLines(content.items).map((line) => ({ ...line, x: line.x - x, y: line.y - y })),
          width: right - x,
          height: top - y,
          rotated: page.rotate !== 0,
        });
      } finally {
        page.cleanup();
      }
    }
    const paragraphs = pdfDocumentParagraphs(pages);
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
