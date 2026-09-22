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
    { title: 'Chapter 1', paragraphs: ['First Chapter', 'Hello world & friends.', 'Div prose.', 'Nested paragraph.', 'Trailing prose.', 'List item.', 'Line one.', 'Line two.', 'Plain body text.'] },
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
    { title: 'Chapter 1', paragraphs: ['Chapter One', 'Alice followed the rabbit.', 'The next paragraph.', 'Plain body text.'] },
  ]);
});

test('EPUB retains prefixed XHTML and CDATA, with a fallback for mislabeled HTML', async () => {
  const zip = await JSZip.loadAsync(await (await book()).arrayBuffer());
  zip.file('Text/first chapter.xhtml', '<x:html xmlns:x="http://www.w3.org/1999/xhtml"><x:head><x:title/></x:head><x:body><x:h1>Namespaced chapter</x:h1><x:p><![CDATA[Text & more text.]]></x:p></x:body></x:html>');
  zip.file('Text/second.xhtml', '<html><head><title>Legacy chapter</title></head><body><p>Legacy&nbsp;text.<br>More text.</p></body></html>');
  const imported = await importBookFromFile(new File([await zip.generateAsync({ type: 'arraybuffer' })], 'mixed.epub'));
  assert.deepEqual(imported.chapters, [
    { title: 'Chapter 1', paragraphs: ['Namespaced chapter', 'Text & more text.', 'Legacy text.', 'More text.'] },
  ]);
});

async function navigationBook(nav?: string, ncx?: string): Promise<File> {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>');
  zip.file('OPS/book.opf', `<package><manifest>
    <item id="a" href="Text/a.xhtml" media-type="application/xhtml+xml"/>
    <item id="b" href="Text/b.xhtml" media-type="application/xhtml+xml"/>
    <item id="c" href="Text/c.xhtml" media-type="application/xhtml+xml"/>
    ${nav === undefined ? '' : '<item id="nav" href="Nav/nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>'}
    ${ncx === undefined ? '' : '<item id="ncx" href="Nav/toc.ncx" media-type="application/x-dtbncx+xml"/>'}
    </manifest><spine toc="ncx"><itemref idref="a"/><itemref idref="b"/><itemref idref="c"/></spine></package>`);
  zip.file('OPS/Text/a.xhtml', '<html><body><p>Opening.</p><h1 id="one">First heading</h1><p>First page.</p></body></html>');
  zip.file('OPS/Text/b.xhtml', '<html><body><p>Second page.</p><p id="two words">Next chapter.</p><p>More text.</p></body></html>');
  zip.file('OPS/Text/c.xhtml', '<html><body><p>Last page.</p></body></html>');
  if (nav !== undefined) zip.file('OPS/Nav/nav.xhtml', nav);
  if (ncx !== undefined) zip.file('OPS/Nav/toc.ncx', ncx);
  return new File([await zip.generateAsync({ type: 'arraybuffer' })], 'navigation.epub');
}

const navDocument = (links: string) => `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
  <nav epub:type="page-list"><ol><li><a href="../Text/a.xhtml">1</a></li><li><a href="../Text/b.xhtml">2</a></li></ol></nav>
  <nav epub:type="toc"><ol>${links}</ol></nav></body></html>`;
const ncxDocument = (points: string) => `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>${points}</navMap></ncx>`;
const point = (label: string, href: string) => `<navPoint><navLabel><text>${label}</text></navLabel><content src="${href}"/></navPoint>`;
const allParagraphs = ['Opening.', 'First heading', 'First page.', 'Second page.', 'Next chapter.', 'More text.', 'Last page.'];

test('EPUB 3 TOC groups pages, resolves encoded fragments, and ignores page-list navigation', async () => {
  const nav = navDocument('<li><a href="../Text/a.xhtml#one">One</a></li><li><a href="../Text/b.xhtml#two%20words">Two</a></li>');
  const imported = await importBookFromFile(await navigationBook(nav));
  assert.deepEqual(imported.chapters, [
    { title: 'Front matter', paragraphs: ['Opening.'] },
    { title: 'One', paragraphs: ['First heading', 'First page.', 'Second page.'] },
    { title: 'Two', paragraphs: ['Next chapter.', 'More text.', 'Last page.'] },
  ]);
});

test('EPUB 2 NCX groups multiple content files under a chapter', async () => {
  const imported = await importBookFromFile(await navigationBook(undefined, ncxDocument(point('One', '../Text/a.xhtml') + point('Two', '../Text/c.xhtml'))));
  assert.deepEqual(imported.chapters, [
    { title: 'One', paragraphs: allParagraphs.slice(0, 6) },
    { title: 'Two', paragraphs: ['Last page.'] },
  ]);
});

test('EPUB NCX splits chapters inside one file and deduplicates nested opening entries', async () => {
  const ncx = ncxDocument(`<navPoint><navLabel><text>Part</text></navLabel><content src="../Text/a.xhtml"/>
    ${point('One', '../Text/a.xhtml')}${point('Two', '../Text/a.xhtml#one')}</navPoint>`);
  const imported = await importBookFromFile(await navigationBook(undefined, ncx));
  assert.deepEqual(imported.chapters, [
    { title: 'One', paragraphs: ['Opening.'] },
    { title: 'Two', paragraphs: allParagraphs.slice(1) },
  ]);
});

test('EPUB prefers EPUB 3 navigation, but tries NCX when it cannot resolve that navigation', async () => {
  const ncx = ncxDocument(point('NCX chapter', '../Text/a.xhtml'));
  const good = navDocument('<li><a href="../Text/a.xhtml">Navigation chapter</a></li>');
  assert.equal((await importBookFromFile(await navigationBook(good, ncx))).chapters[0].title, 'Navigation chapter');
  const bad = navDocument('<li><a href="../Text/a.xhtml#missing">Broken</a></li>');
  assert.equal((await importBookFromFile(await navigationBook(bad, ncx))).chapters[0].title, 'NCX chapter');
});

test('EPUB missing, malformed, empty, external, partial or unordered TOCs fall back to one complete chapter', async () => {
  for (const nav of [undefined, '<broken', navDocument(''),
    navDocument('<li><a href="https://example.com/book">External</a></li>'),
    navDocument('<li><a href="../Text/a.xhtml">Good</a></li><li><a href="../Text/missing.xhtml">Missing</a></li>'),
    navDocument('<li><a href="../Text/a.xhtml#absent">Missing anchor</a></li>'),
    navDocument('<li><a href="../Text/c.xhtml">Last</a></li><li><a href="../Text/a.xhtml">First</a></li>'),
  ]) {
    const imported = await importBookFromFile(await navigationBook(nav));
    assert.deepEqual(imported.chapters, [{ title: 'Chapter 1', paragraphs: allParagraphs }]);
  }
});
