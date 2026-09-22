import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { JSDOM } from 'jsdom';
import { importBookFromFile } from '../src/core/book-parser.js';

const dom = new JSDOM('');
globalThis.DOMParser = dom.window.DOMParser;

async function book(options: { metadata?: string; missing?: boolean; empty?: boolean; encrypted?: boolean } = {}): Promise<File> {
  const zip = new JSZip();
  if (options.encrypted) zip.file('META-INF/encryption.xml', '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><CipherData><CipherReference URI="Text/first%20chapter.xhtml"/></CipherData></EncryptedData></encryption>');
  zip.file('META-INF/container.xml', '<c:container xmlns:c="urn:oasis:names:tc:opendocument:xmlns:container"><c:rootfiles><c:rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></c:rootfiles></c:container>');
  zip.file('OPS/book.opf', `<opf:package xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <opf:metadata>${options.metadata ?? '<dc:title>The Book</dc:title><dc:creator>An Author</dc:creator>'}</opf:metadata>
    <opf:manifest>
      <opf:item id="second" href="../Text/second.xhtml" media-type="application/xhtml+xml"/>
      <opf:item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
      <opf:item id="first" href="../Text/first%20chapter.xhtml#start" media-type="application/xhtml+xml"/>
      <opf:item id="extra" href="missing.xhtml" media-type="application/xhtml+xml"/>
    </opf:manifest>
    <opf:spine><opf:itemref idref="nav"/><opf:itemref idref="first"/><opf:itemref idref="second"/><opf:itemref idref="extra" linear="no"/></opf:spine>
  </opf:package>`);
  if (!options.missing) zip.file('Text/first chapter.xhtml', options.empty ? '<html><body><img src="cover.jpg"/></body></html>' : `<html><head><title>Generic title</title><style>ignored style</style></head><body>
    <h1>First Chapter</h1><p>Hello <em>world</em> &amp; friends.</p>
    <div>Div prose.<p>Nested paragraph.</p>Trailing prose.</div>
    <ul><li>List item.</li></ul><p>Line one.<br/>Line two.</p>
    <script>ignored script</script><nav>ignored navigation</nav><p hidden>hidden text</p>
  </body></html>`);
  zip.file('Text/second.xhtml', options.empty ? '<html><body></body></html>' : '<html><head><title>Second Chapter</title></head><body>Plain body text.</body></html>');
  return new File([await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })], 'filename.EPUB', { type: 'application/epub+zip' });
}

test('EPUB upload preserves metadata, spine order and mixed block content', async () => {
  const imported = await importBookFromFile(await book());
  assert.equal(imported.sourceType, 'epub');
  assert.equal(imported.title, 'The Book');
  assert.equal(imported.author, 'An Author');
  assert.equal(imported.currentChapter, 1);
  assert.deepEqual(imported.chapters, [
    { title: 'First Chapter', paragraphs: ['Hello world & friends.', 'Div prose.', 'Nested paragraph.', 'Trailing prose.', 'List item.', 'Line one.', 'Line two.'] },
    { title: 'Second Chapter', paragraphs: ['Plain body text.'] },
  ]);
});

test('EPUB metadata falls back to filename and unknown author', async () => {
  const imported = await importBookFromFile(await book({ metadata: '' }));
  assert.equal(imported.title, 'filename');
  assert.equal(imported.author, 'Unknown Author');
});

test('EPUB missing chapters fail instead of silently importing an incomplete book', async () => {
  await assert.rejects(importBookFromFile(await book({ missing: true })), /Missing EPUB file/);
});

test('EPUB rejects unreadable and invalid archives with an actionable error', async () => {
  await assert.rejects(importBookFromFile(await book({ encrypted: true })), /DRM-protected EPUB/);
  await assert.rejects(importBookFromFile(await book({ empty: true })), /No readable text could be extracted/);
  await assert.rejects(importBookFromFile(new File(['not a zip'], 'broken.epub')), /Could not import EPUB/);
  const zip = new JSZip().file('META-INF/container.xml', '<broken');
  await assert.rejects(importBookFromFile(new File([await zip.generateAsync({ type: 'arraybuffer' })], 'bad-xml.epub')), /Invalid EPUB XML/);
});

test('EPUB reports an unreadable chapter list separately from empty chapter text', async () => {
  const zip = await JSZip.loadAsync(await (await book()).arrayBuffer());
  const opf = zip.file('OPS/book.opf')!;
  zip.file('OPS/book.opf', (await opf.async('string')).replace(/<opf:spine>[\s\S]*?<\/opf:spine>/, '<opf:spine/>'));
  const file = new File([await zip.generateAsync({ type: 'arraybuffer' })], 'no-spine.epub');
  await assert.rejects(importBookFromFile(file), /Could not read the EPUB chapter list/);
});

test('EPUB XHTML self-closing head tags do not swallow chapters after an image cover', async () => {
  const zip = await JSZip.loadAsync(await (await book()).arrayBuffer());
  const opf = zip.file('OPS/book.opf')!;
  zip.file('OPS/book.opf', (await opf.async('string'))
    .replace('<opf:manifest>', '<opf:manifest><opf:item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>')
    .replace('<opf:spine>', '<opf:spine><opf:itemref idref="cover"/>'));
  zip.file('OPS/cover.xhtml', `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title/></head>
    <body><svg xmlns="http://www.w3.org/2000/svg"><image href="cover.jpg"/></svg></body></html>`);
  zip.file('Text/first chapter.xhtml', `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml">
    <head><title/><script/><style/><link rel="stylesheet" href="book.css"/></head>
    <body><h2>Chapter One</h2><p>Alice followed the rabbit.</p><p/><p>The next paragraph.</p></body></html>`);
  const imported = await importBookFromFile(new File([await zip.generateAsync({ type: 'arraybuffer' })], 'self-closing.epub'));
  assert.deepEqual(imported.chapters, [
    { title: 'Chapter One', paragraphs: ['Alice followed the rabbit.', 'The next paragraph.'] },
    { title: 'Second Chapter', paragraphs: ['Plain body text.'] },
  ]);
});

test('EPUB retains prefixed XHTML and CDATA, with a fallback for mislabeled HTML', async () => {
  const zip = await JSZip.loadAsync(await (await book()).arrayBuffer());
  zip.file('Text/first chapter.xhtml', '<x:html xmlns:x="http://www.w3.org/1999/xhtml"><x:head><x:title/></x:head><x:body><x:h1>Namespaced chapter</x:h1><x:p><![CDATA[Text & more text.]]></x:p></x:body></x:html>');
  zip.file('Text/second.xhtml', '<html><head><title>Legacy chapter</title></head><body><p>Legacy&nbsp;text.<br>More text.</p></body></html>');
  const imported = await importBookFromFile(new File([await zip.generateAsync({ type: 'arraybuffer' })], 'mixed.epub'));
  assert.deepEqual(imported.chapters, [
    { title: 'Namespaced chapter', paragraphs: ['Text & more text.'] },
    { title: 'Legacy chapter', paragraphs: ['Legacy text.', 'More text.'] },
  ]);
});
