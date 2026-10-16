import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTxtBook, importBookFromFile } from '../src/core/book-parser.js';

test('TXT chapters preserve front matter and recognize conservative Roman and part headings', async () => {
  const text = '\n\nFront note.\n\nChapter IV\nA retained paragraph.\n\nPart II: Interlude\nMiddle text.\n';
  assert.deepEqual(parseTxtBook(text), [
    { title: 'Front matter', paragraphs: ['Front note.'] },
    { title: 'Chapter IV', paragraphs: ['A retained paragraph.'] },
    { title: 'Part II: Interlude', paragraphs: ['Middle text.'] },
  ]);
  const book = await importBookFromFile(new File([text], 'structured.txt'));
  assert.deepEqual(book.navigation?.map((entry) => entry.title), ['Front matter', 'Chapter IV', 'Part II: Interlude']);
});

