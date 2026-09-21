import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { importBookFromFile } from '../src/core/book-parser.js';

globalThis.DOMParser = new JSDOM('').window.DOMParser;
const file = (xml: string) => new File([xml], 'fallback.FB2', { type: 'application/x-fictionbook+xml' });

test('FB2 imports metadata and nested sections in order without duplicated content', async () => {
  const book = await importBookFromFile(file(`<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
    <description><title-info><book-title>A Book</book-title><author><first-name>First</first-name><last-name>Last</last-name></author><author><nickname>Pen Name</nickname></author><annotation><p>Excluded annotation.</p></annotation></title-info></description>
    <body><title><p>Body title</p></title><p>Preface.</p><section><title><p>Part One</p></title><p>Hello <emphasis>world</emphasis> &amp; friends.</p>
      <section><title><p>Nested</p><p>Chapter</p></title><p>Inner paragraph.</p><poem><stanza><v>Verse one.</v><v>Verse two.</v></stanza></poem></section>
      <p>After nested section.</p><table><tr><td>First cell</td><td>Second cell</td></tr></table>
    </section></body><body name="notes"><section><p>Excluded footnote.</p></section></body><binary>Excluded binary.</binary>
  </FictionBook>`));
  assert.equal(book.sourceType, 'fb2');
  assert.equal(book.title, 'A Book');
  assert.equal(book.author, 'First Last, Pen Name');
  assert.deepEqual(book.chapters, [
    { title: 'Body title', paragraphs: ['Preface.'] },
    { title: 'Part One', paragraphs: ['Hello world & friends.'] },
    { title: 'Nested Chapter', paragraphs: ['Inner paragraph.', 'Verse one.', 'Verse two.'] },
    { title: 'Part One', paragraphs: ['After nested section.', 'First cell Second cell'] },
  ]);
});

test('FB2 supports prefixed namespaces, metadata fallback and untitled sections', async () => {
  const book = await importBookFromFile(file('<f:FictionBook xmlns:f="http://www.gribuser.ru/xml/fictionbook/2.0"><f:body><f:section><f:p>Readable.</f:p></f:section></f:body></f:FictionBook>'));
  assert.equal(book.title, 'fallback');
  assert.equal(book.author, 'Unknown Author');
  assert.deepEqual(book.chapters, [{ title: 'Chapter 1', paragraphs: ['Readable.'] }]);
});

test('FB2 decodes declared Windows-1251 and UTF-16 encodings', async () => {
  const prefix = '<?xml version="1.0" encoding="windows-1251"?><FictionBook><body><section><p>';
  const suffix = '</p></section></body></FictionBook>';
  const bytes = new Uint8Array([...new TextEncoder().encode(prefix), 0xcc, 0xe8, 0xf0, ...new TextEncoder().encode(suffix)]);
  const legacy = await importBookFromFile(new File([bytes], 'legacy.fb2'));
  assert.equal(legacy.chapters[0].paragraphs[0], 'Мир');
  const utf16 = Buffer.from('\uFEFF<FictionBook><body><p>Hello.</p></body></FictionBook>', 'utf16le');
  const wide = await importBookFromFile(new File([utf16], 'wide.fb2'));
  assert.equal(wide.chapters[0].paragraphs[0], 'Hello.');
});

test('FB2 rejects malformed, unrelated, empty and DTD-bearing XML', async () => {
  for (const xml of ['<FictionBook>', '<html/>', '<FictionBook><body/></FictionBook>', '<!DOCTYPE FictionBook><FictionBook/>']) {
    await assert.rejects(importBookFromFile(file(xml)), /Could not import FB2/);
  }
});
