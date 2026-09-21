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
  await assert.rejects(importBookFromFile(await book({ empty: true })), /No readable chapters/);
  await assert.rejects(importBookFromFile(new File(['not a zip'], 'broken.epub')), /Could not import EPUB/);
  const zip = new JSZip().file('META-INF/container.xml', '<broken');
  await assert.rejects(importBookFromFile(new File([await zip.generateAsync({ type: 'arraybuffer' })], 'bad-xml.epub')), /Invalid EPUB XML/);
});
