import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { getBookById, upsertBook } from '../src/core/books-store.js';
import { importBookFromFile } from '../src/core/book-parser.js';

import { chapterTitleForReader, readerAnchorChapter, readerBlocksForChapter } from '../src/core/reader-content.js';

globalThis.DOMParser = new JSDOM('').window.DOMParser;
const file = (xml: string) => new File([xml], 'fallback.FB2', { type: 'application/x-fictionbook+xml' });

function plainChapters(book: Awaited<ReturnType<typeof importBookFromFile>>) {
  return book.chapters.map(({ title, paragraphs }) => ({ title, paragraphs }));
}

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
  assert.deepEqual(plainChapters(book), [
    { title: 'Body title', paragraphs: ['Body title', 'Preface.'] },
    { title: 'Part One', paragraphs: ['Part One', 'Hello world & friends.'] },
    { title: 'Nested Chapter', paragraphs: ['Nested', 'Chapter', 'Inner paragraph.', 'Verse one.', 'Verse two.'] },
    { title: 'Part One', paragraphs: ['After nested section.', 'First cell Second cell'] },
    { title: 'Chapter 5', paragraphs: ['Excluded footnote.'] },
  ]);
});

test('FB2 supports prefixed namespaces, metadata fallback and untitled sections', async () => {
  const book = await importBookFromFile(file('<f:FictionBook xmlns:f="http://www.gribuser.ru/xml/fictionbook/2.0"><f:body><f:section><f:p>Readable.</f:p></f:section></f:body></f:FictionBook>'));
  assert.equal(book.title, 'fallback');
  assert.equal(book.author, 'Unknown Author');
  assert.deepEqual(plainChapters(book), [{ title: 'Chapter 1', paragraphs: ['Readable.'] }]);
});

test('FB2 preserves emphasis, embedded images and paragraph text for analysis', async () => {
  const book = await importBookFromFile(file(`<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:xlink="http://www.w3.org/1999/xlink">
    <stylesheet type="text/css">.center { text-align: center } .distinct { color: red }</stylesheet>
    <binary id="image1" content-type="image/png">iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5nkAAAAASUVORK5CYII=</binary>
    <body><section><p style="center">A <strong>bold</strong> and <emphasis>italic</emphasis> word <image xlink:href="#image1"/></p></section></body>
  </FictionBook>`));
  assert.deepEqual(book.chapters[0].paragraphs, ['A bold and italic word ']);
  const paragraph = book.chapters[0].readerBlocks?.find((block) => block.type === 'paragraph');
  assert.equal(paragraph?.type === 'paragraph' && paragraph.style?.textAlign, 'center');
  assert.equal(paragraph?.type === 'paragraph' && paragraph.content.some((part) => part.type === 'text' && part.marks.includes('strong')), true);
  assert.equal(paragraph?.type === 'paragraph' && paragraph.content.some((part) => part.type === 'text' && part.marks.includes('emphasis')), true);
  const image = paragraph?.type === 'paragraph' ? paragraph.content.find((part) => part.type === 'image') : undefined;
  assert.equal(image?.type === 'image' && image.src.startsWith('data:image/png;base64,'), true);
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

test('FB2 retains multi-paragraph parent titles, named inline styles, blank lines, and stanza separators', async () => {
  const imported = await importBookFromFile(file(`<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
    <stylesheet type="text/css">.center { text-align: center } .distinct { color: red }</stylesheet>
    <body><section id="part"><title><p style="center"><strong>Part</strong></p><empty-line/><p><style name="distinct">One</style></p></title>
      <section><title><p>Child</p></title><epigraph><p>A quotation.</p></epigraph><poem><title><p>Poem</p></title>
        <stanza><v>Verse one.</v></stanza><stanza><v>Verse two.</v></stanza></poem></section>
    </section></body></FictionBook>`));
  assert.deepEqual(imported.chapters.map((chapter) => chapter.paragraphs), [['Part', 'One'], ['Child', 'A quotation.', 'Poem', 'Verse one.', 'Verse two.']]);
  assert.equal(chapterTitleForReader(imported.chapters[0], 1), null);
  assert.equal(chapterTitleForReader(imported.chapters[1], 2), null);
  const parent = readerBlocksForChapter(imported.chapters[0].paragraphs, imported.chapters[0].readerBlocks);
  assert.deepEqual(parent.map((block) => block.type), ['paragraph', 'spacer', 'paragraph']);
  assert.equal(parent[0].type === 'paragraph' && parent[0].style?.textAlign, 'center');
  assert.equal(parent[2].type === 'paragraph' && parent[2].content.some((part) => part.type === 'text' && part.style?.color === 'red'), true);
  assert.equal(imported.chapters[1].readerBlocks?.some((block) => block.type === 'paragraph' && block.blockType === 'blockquote'), true);
  assert.equal(imported.chapters[1].readerBlocks?.filter((block) => block.type === 'spacer').length, 1);
});

test('FB2 notes remain link-accessible, and parent continuations do not repeat their title', async () => {
  const imported = await importBookFromFile(file(`<FictionBook xmlns:xlink="http://www.w3.org/1999/xlink"><body><section>
    <title><p>Parent</p></title><p>Before <a type="note" xlink:href="#note">1</a>.</p><section><p>Nested prose.</p></section><p>After.</p>
    </section></body><body name="notes"><section id="note"><title><p>Note</p></title><p>Note text.</p></section></body></FictionBook>`));
  assert.equal(imported.chapters[2].titlePresentation, 'continuation');
  assert.equal(chapterTitleForReader(imported.chapters[2], 3), null);
  assert.equal(imported.chapters[3].linear, false);
  assert.equal(readerAnchorChapter(imported.chapters, 'reader-fb2-note'), 4);
  assert.equal(imported.chapters[0].readerBlocks?.some((block) => block.type === 'paragraph' && block.content.some((part) => part.type === 'text' && part.href === '#reader-fb2-note')), true);
});

test('FB2 image-only sections survive and invalid image references fail explicitly', async () => {
  const imported = await importBookFromFile(file('<FictionBook xmlns:xlink="http://www.w3.org/1999/xlink"><body><section><image xlink:href="#cover"/></section></body><binary id="cover" content-type="image/png">AAAA</binary></FictionBook>'));
  assert.deepEqual(imported.chapters[0].paragraphs, []);
  assert.equal(imported.chapters[0].readerBlocks?.[0].type, 'image');
  await assert.rejects(importBookFromFile(file('<FictionBook xmlns:xlink="http://www.w3.org/1999/xlink"><body><section><image xlink:href="#missing"/></section></body></FictionBook>')), /missing binary data/);
  await assert.rejects(importBookFromFile(file('<FictionBook><body><section><p>Prose.</p></section></body><binary id="bad" content-type="image/png">A</binary></FictionBook>')), /Invalid FB2 image binary/);
});


test('imported rich content, titles, anchors and image-only chapters survive book storage', async () => {
  const storage = new JSDOM('', { url: 'https://reader.test/' }).window.localStorage;
  globalThis.localStorage = storage;
  const imported = await importBookFromFile(file(`<FictionBook xmlns:xlink="http://www.w3.org/1999/xlink"><body>
    <section><title><p><strong>Title</strong></p><empty-line/><p>Subtitle</p></title><p>Prose.</p></section>
    <section><image xlink:href="#cover"/></section></body><body name="notes"><section id="note"><p>Note.</p></section></body>
    <binary id="cover" content-type="image/png">AAAA</binary></FictionBook>`));
  await upsertBook(imported);
  const saved = await getBookById(imported.id);
  assert.deepEqual(saved?.chapters, imported.chapters);
  for (const chapter of saved?.chapters ?? []) readerBlocksForChapter(chapter.paragraphs, chapter.readerBlocks);
});
