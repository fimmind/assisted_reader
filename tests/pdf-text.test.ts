import test from 'node:test';
import assert from 'node:assert/strict';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { pdfPageParagraphs } from '../src/core/pdf-text.js';

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
