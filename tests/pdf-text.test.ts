import test from 'node:test';
import assert from 'node:assert/strict';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { pdfPageParagraphs, pdfDocumentParagraphs, pdfTextLines } from '../src/core/pdf-text.js';
import type { PdfTextPage } from '../src/core/pdf-text.js';

function item(str: string, x = 50, y = 700, hasEOL = true, width = str.length * 6): TextItem {
  return { str, dir: 'ltr', transform: [12, 0, 0, 12, x, y], width, height: 12, fontName: 'test', hasEOL };
}

test('PDF wrapped lines join, while paragraph gaps and indents remain separate', () => {
  assert.deepEqual(pdfPageParagraphs([
    item('First wrapped'), item('line.', 50, 684),
    item('Second paragraph.', 50, 650),
    item('Indented paragraph.', 65, 634), item('Continued.', 50, 618),
  ]), ['First wrapped line.', 'Second paragraph.', 'Indented paragraph. Continued.']);
});

test('PDF dehyphenation applies only within a paragraph', () => {
  assert.deepEqual(pdfPageParagraphs([
    item('An inter-'), item('national agreement.', 50, 684),
    item('Separate- ', 50, 650), item('paragraph.', 50, 612),
  ]), ['An international agreement.', 'Separate-', 'paragraph.']);
});

test('PDF font runs preserve words, infer gaps and avoid spaces before punctuation', () => {
  assert.deepEqual(pdfPageParagraphs([
    item('Hel', 50, 700, false, 18), item('lo', 68, 700, false, 12),
    item('world', 86, 700, false, 30), item(' !', 116),
  ]), ['Hello world!']);
});

test('PDF line coordinates work without EOL flags and empty content is ignored', () => {
  assert.deepEqual(pdfPageParagraphs([
    { type: 'beginMarkedContent', id: 'test' },
    item('A soft\u00ad', 50, 700, false), item('hyphen.', 50, 684, false),
    item('   ', 50, 640),
  ]), ['A softhyphen.']);
  assert.deepEqual(pdfPageParagraphs([item('   ')]), []);
});

function page(items: TextItem[]): PdfTextPage {
  return { lines: pdfTextLines(items), width: 600, height: 800 };
}

test('PDF removes repeated running headers and changing page numbers, preserving body repetitions', () => {
  const pages = [1, 2, 3].map((n) => page([
    item('A running title', 50, 770), item('Repeated body text.', 50, 700),
    item(`Unique page ${n}.`, 50, 400), item(`Page ${n} of 3`, 280, 30),
  ]));
  assert.deepEqual(pdfDocumentParagraphs(pages), [
    'Repeated body text.', 'Unique page 1.', 'Repeated body text.', 'Unique page 2.', 'Repeated body text.', 'Unique page 3.',
  ]);
});

test('PDF removes alternating two-line margin text and Roman page numbers', () => {
  const pages = ['i', 'ii', 'iii', 'iv'].map((n, index) => page([
    item(index % 2 ? 'Author Name' : 'Book Title', 50, 775), item('Running subtitle', 50, 760),
    item(`Body ${index}.`, 50, 690), item(n, 280, 25),
  ]));
  assert.deepEqual(pdfDocumentParagraphs(pages), ['Body 0.', 'Body 1.', 'Body 2.', 'Body 3.']);
});

test('PDF keeps one-off margin text, chapter headings and text without a margin gap', () => {
  assert.deepEqual(pdfDocumentParagraphs([
    page([item('Unique dedication', 50, 770), item('Body.', 50, 690)]),
    page([item('Chapter 1', 50, 770), item('Body.', 50, 690)]),
    page([item('Chapter 2', 50, 770), item('Body.', 50, 690)]),
  ]), ['Unique dedication', 'Body.', 'Chapter 1', 'Body.', 'Chapter 2', 'Body.']);
  const tight = page([item('Repeated prose', 50, 735), item('continues.', 50, 719)]);
  assert.deepEqual(pdfDocumentParagraphs([tight, tight]), ['Repeated prose continues.', 'Repeated prose continues.']);
});

test('PDF joins clear cross-page continuations after removing margins and repairs split words', () => {
  assert.deepEqual(pdfDocumentParagraphs([
    page([item('Running title', 50, 770), item('The story opens.', 50, 690), item('An inter-', 50, 100), item('1', 280, 25)]),
    page([item('Running title', 50, 770), item('national journey', 50, 690), item('continues across', 50, 100), item('2', 280, 25)]),
    page([item('Running title', 50, 770), item('another page.', 50, 690), item('3', 280, 25)]),
  ]), ['The story opens.', 'An international journey', 'continues across another page.']);
});

test('PDF preserves page breaks at sentence endings, indents, headings, blank pages and layout changes', () => {
  const previous = page([item('An unfinished thought', 50, 100)]);
  for (const next of [
    page([item('Chapter Two', 50, 690)]),
    page([item('indented paragraph', 70, 690), item('continues.', 50, 674)]),
    page([item('lowercase mid-page content', 50, 400)]),
    { ...page([item('rotated continuation', 50, 690)]), rotated: true },
    page([{ ...item('large heading', 50, 690), height: 24 }]),
  ]) {
    assert.equal(pdfDocumentParagraphs([previous, next])[0], 'An unfinished thought');
  }
  assert.deepEqual(pdfDocumentParagraphs([page([item('Finished.”', 50, 100)]), page([item('lowercase start.', 50, 690)])]), ['Finished.”', 'lowercase start.']);
  assert.deepEqual(pdfDocumentParagraphs([previous, page([]), page([item('lowercase start.', 50, 690)])]), ['An unfinished thought', 'lowercase start.']);
  assert.deepEqual(pdfDocumentParagraphs([page([item('Ends mid-page', 50, 400)]), page([item('lowercase start.', 50, 690)])]), ['Ends mid-page', 'lowercase start.']);
});
