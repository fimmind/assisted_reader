import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { JSDOM } from 'jsdom';
import { importBookFromFile } from '../src/core/book-parser.js';

import { chapterTitleForReader, readerAnchorChapter, readerBlocksForChapter } from '../src/core/reader-content.js';

const dom = new JSDOM('');
globalThis.DOMParser = dom.window.DOMParser;

async function book(options: { metadata?: string; missing?: boolean; empty?: boolean; encrypted?: boolean }): Promise<File> {
  const zip = new JSZip();
  zip.file('Text/cover.png', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5nkAAAAASUVORK5CYII=', { base64: true });
  zip.file('OPS/cover.png', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5nkAAAAASUVORK5CYII=', { base64: true });
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
    <opf:spine><opf:itemref idref="nav" linear="no"/><opf:itemref idref="first"/><opf:itemref idref="second"/><opf:itemref idref="extra" linear="no"/></opf:spine>
  </opf:package>`);
  zip.file('OPS/nav.xhtml', '<html><body/></html>');
  zip.file('OPS/missing.xhtml', '<html><body/></html>');
  if (!options.missing) zip.file('Text/first chapter.xhtml', options.empty ? '<html><body><img src="cover.png"/></body></html>' : `<html><head><title>Generic title</title><style>ignored style</style></head><body>
    <h1>First Chapter</h1><p>Hello <em>world</em> &amp; friends.</p>
    <div>Div prose.<p>Nested paragraph.</p>Trailing prose.</div>
    <ul><li>List item.</li></ul><p>Line one.<br/>Line two.</p>
    <script>ignored script</script><nav>ignored navigation</nav><p hidden>hidden text</p>
  </body></html>`);
  zip.file('Text/second.xhtml', options.empty ? '<html><body></body></html>' : '<html><head><title>Second Chapter</title></head><body>Plain body text.</body></html>');
  return new File([await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })], 'filename.EPUB', { type: 'application/epub+zip' });
}

function plainChapters(book: Awaited<ReturnType<typeof importBookFromFile>>) {
  return book.chapters.map(({ title, paragraphs }) => ({ title, paragraphs }));
}

test('EPUB upload preserves metadata, spine order and mixed block content', async () => {
  const imported = await importBookFromFile(await book({}));
  assert.equal(imported.sourceType, 'epub');
  assert.equal(imported.title, 'The Book');
  assert.equal(imported.author, 'An Author');
  assert.equal(imported.currentChapter, 1);
  assert.deepEqual(plainChapters(imported), [
    { title: 'Chapter 1', paragraphs: ['First Chapter', 'Hello world & friends.', 'Div prose.', 'Nested paragraph.', 'Trailing prose.', 'List item.', 'Line one.\nLine two.', 'ignored navigation', 'Plain body text.'] },
  ]);
  const richParagraph = imported.chapters[0].readerBlocks?.find((block) => block.type === 'paragraph' && block.paragraphIndex === 1);
  assert.equal(richParagraph?.type, 'paragraph');
  assert.equal(richParagraph?.type === 'paragraph' ? richParagraph.content.map((part) => part.type === 'text' ? part.text : '').join('') : '', 'Hello world & friends.');
  assert.equal(richParagraph?.type === 'paragraph' && richParagraph.content.some((part) => part.type === 'text' && part.marks.includes('emphasis')), true);
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
  const illustrated = await importBookFromFile(await book({ empty: true }));
  assert.equal(illustrated.chapters[0].readerBlocks?.some((block) => block.type === 'image'), true);
  await assert.rejects(importBookFromFile(new File(['not a zip'], 'broken.epub')), /Could not import EPUB/);
  const zip = new JSZip().file('META-INF/container.xml', '<broken');
  await assert.rejects(importBookFromFile(new File([await zip.generateAsync({ type: 'arraybuffer' })], 'bad-xml.epub')), /Invalid EPUB XML/);
});

test('EPUB reports an unreadable chapter list separately from empty chapter text', async () => {
  const zip = await JSZip.loadAsync(await (await book({})).arrayBuffer());
  const opf = zip.file('OPS/book.opf')!;
  zip.file('OPS/book.opf', (await opf.async('string')).replace(/<opf:spine>[\s\S]*?<\/opf:spine>/, '<opf:spine/>'));
  const file = new File([await zip.generateAsync({ type: 'arraybuffer' })], 'no-spine.epub');
  await assert.rejects(importBookFromFile(file), /Could not read the EPUB chapter list/);
});

test('EPUB XHTML self-closing head tags do not swallow chapters after an image cover', async () => {
  const zip = await JSZip.loadAsync(await (await book({})).arrayBuffer());
  const opf = zip.file('OPS/book.opf')!;
  zip.file('OPS/book.opf', (await opf.async('string'))
    .replace('<opf:manifest>', '<opf:manifest><opf:item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>')
    .replace('<opf:spine>', '<opf:spine><opf:itemref idref="cover"/>'));
  zip.file('OPS/cover.xhtml', `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title/></head>
    <body><svg xmlns="http://www.w3.org/2000/svg"><image href="cover.png"/></svg></body></html>`);
  zip.file('Text/first chapter.xhtml', `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml">
    <head><title/><script/><style/><link rel="stylesheet" href="book.css"/></head>
    <body><h2>Chapter One</h2><p>Alice followed the rabbit.</p><p/><p>The next paragraph.</p></body></html>`);
  zip.file('Text/book.css', '');
  const imported = await importBookFromFile(new File([await zip.generateAsync({ type: 'arraybuffer' })], 'self-closing.epub'));
  assert.deepEqual(plainChapters(imported), [
    { title: 'Chapter 1', paragraphs: ['Chapter One', 'Alice followed the rabbit.', 'The next paragraph.', 'Plain body text.'] },
  ]);
});

test('EPUB retains prefixed XHTML and CDATA, with a fallback for mislabeled HTML', async () => {
  const zip = await JSZip.loadAsync(await (await book({})).arrayBuffer());
  zip.file('Text/first chapter.xhtml', '<x:html xmlns:x="http://www.w3.org/1999/xhtml"><x:head><x:title/></x:head><x:body><x:h1>Namespaced chapter</x:h1><x:p><![CDATA[Text & more text.]]></x:p></x:body></x:html>');
  zip.file('Text/second.xhtml', '<html><head><title>Legacy chapter</title></head><body><p>Legacy&nbsp;text.<br>More text.</p></body></html>');
  const imported = await importBookFromFile(new File([await zip.generateAsync({ type: 'arraybuffer' })], 'mixed.epub'));
  assert.deepEqual(plainChapters(imported), [
    { title: 'Chapter 1', paragraphs: ['Namespaced chapter', 'Text & more text.', 'Legacy\u00a0text.\nMore text.'] },
  ]);
});

test('EPUB retains linked stylesheet presentation, inline marks, hyperlinks and embedded images', async () => {
  const zip = await JSZip.loadAsync(await (await book({})).arrayBuffer());
  zip.file('OPS/Styles/book.css', '.chapter { text-align: center; font-size: 1.4em; } .lead { text-indent: 1em; color: #234567; }');
  zip.file('Text/first chapter.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml">
    <head><link rel="stylesheet" href="page-template.xpgt"/><link rel="stylesheet" type="application/vnd.adobe-page-template+xml" href="page-template-typed.xpgt"/><link rel="stylesheet" href="../OPS/Styles/book.css"/></head>
    <body><h2 class="chapter">A chapter heading</h2><p class="lead" id="lead">A <strong>bold</strong> and <em>italic</em> word, plus <a href="https://example.com">a link</a>.</p>
    <figure><img src="cover.png" alt="Small cover"/><figcaption>Image caption.</figcaption></figure></body></html>`);
  const imported = await importBookFromFile(new File([await zip.generateAsync({ type: 'arraybuffer' })], 'styled.epub'));
  assert.deepEqual(plainChapters(imported)[0].paragraphs.slice(0, 2), ['A chapter heading', 'A bold and italic word, plus a link.']);
  const heading = imported.chapters[0].readerBlocks?.find((block) => block.type === 'paragraph' && block.paragraphIndex === 0);
  assert.equal(heading?.type === 'paragraph' && heading.blockType, 'heading');
  assert.equal(heading?.type === 'paragraph' && heading.style?.textAlign, 'center');
  const paragraph = imported.chapters[0].readerBlocks?.find((block) => block.type === 'paragraph' && block.paragraphIndex === 1);
  assert.equal(paragraph?.type === 'paragraph' && paragraph.content.some((part) => part.type === 'text' && part.marks.includes('strong')), true);
  assert.equal(paragraph?.type === 'paragraph' && paragraph.content.some((part) => part.type === 'text' && part.marks.includes('emphasis')), true);
  assert.equal(paragraph?.type === 'paragraph' && paragraph.content.some((part) => part.type === 'text' && part.href === 'https://example.com'), true);
  const image = imported.chapters[0].readerBlocks?.find((block) => block.type === 'image');
  assert.equal(image?.type === 'image' && image.src.startsWith('data:image/png;base64,'), true);
  assert.equal(image?.type === 'image' && image.alt, 'Small cover');
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
  zip.file('OPS/Text/b.xhtml', '<html><body><p>Second page.</p><img src="scene.png" alt="Chapter boundary image"/><p id="two words">Next chapter.</p><p>More text.</p></body></html>');
  zip.file('OPS/Text/scene.png', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5nkAAAAASUVORK5CYII=', { base64: true });
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
  assert.deepEqual(plainChapters(imported), [
    { title: 'Front matter', paragraphs: ['Opening.'] },
    { title: 'One', paragraphs: ['First heading', 'First page.', 'Second page.'] },
    { title: 'Two', paragraphs: ['Next chapter.', 'More text.', 'Last page.'] },
  ]);
  const oneImage = imported.chapters[1].readerBlocks?.find((block) => block.type === 'image');
  assert.equal(oneImage?.type === 'image' && oneImage.alt, 'Chapter boundary image');
  assert.equal(imported.chapters[2].readerBlocks?.some((block) => block.type === 'image'), false);
});

test('EPUB 2 NCX groups multiple content files under a chapter', async () => {
  const imported = await importBookFromFile(await navigationBook(undefined, ncxDocument(point('One', '../Text/a.xhtml') + point('Two', '../Text/c.xhtml'))));
  assert.deepEqual(plainChapters(imported), [
    { title: 'One', paragraphs: allParagraphs.slice(0, 6) },
    { title: 'Two', paragraphs: ['Last page.'] },
  ]);
});

test('EPUB NCX splits chapters inside one file and deduplicates nested opening entries', async () => {
  const ncx = ncxDocument(`<navPoint><navLabel><text>Part</text></navLabel><content src="../Text/a.xhtml"/>
    ${point('One', '../Text/a.xhtml')}${point('Two', '../Text/a.xhtml#one')}</navPoint>`);
  const imported = await importBookFromFile(await navigationBook(undefined, ncx));
  assert.deepEqual(plainChapters(imported), [
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
    assert.deepEqual(plainChapters(imported), [{ title: 'Chapter 1', paragraphs: allParagraphs }]);
  }
});

test('EPUB keeps navigation labels separate from styled titles and preserves every analysis paragraph', async () => {
  const zip = await JSZip.loadAsync(await (await navigationBook(navDocument('<li><a href="../Text/a.xhtml#one">A different navigation label</a></li>'))).arrayBuffer());
  zip.file('OPS/Text/a.xhtml', '<html><body><h1 id="one"><em>1</em></h1><h2>A subtitle</h2><p>Opening prose.</p></body></html>');
  const imported = await importBookFromFile(new File([await zip.generateAsync({ type: 'arraybuffer' })], 'titles.epub'));
  const chapter = imported.chapters[0];
  assert.equal(chapter.title, 'A different navigation label');
  assert.equal(chapterTitleForReader(chapter, 1), null);
  assert.deepEqual(chapter.paragraphs.slice(0, 3), ['1', 'A subtitle', 'Opening prose.']);
  const blocks = readerBlocksForChapter(chapter.paragraphs, chapter.readerBlocks);
  const title = blocks.find((block) => block.type === 'paragraph');
  assert.equal(title?.type === 'paragraph' && title.content.some((part) => part.type === 'text' && part.marks.includes('emphasis')), true);
  assert.equal(readerAnchorChapter(imported.chapters, 'reader-epub-OPS%2FText%2Fa.xhtml--one'), 1);
});

test('EPUB preserves nested list paragraphs, explicit line breaks and nonbreaking spaces', async () => {
  const zip = await JSZip.loadAsync(await (await book({})).arrayBuffer());
  zip.file('Text/first chapter.xhtml', '<html><body><ol start="3"><li><p>First <em>part</em>.</p><p>Second part.</p><ul><li>Nested item.</li></ul></li><li>Next item.</li></ol><p><br/>A&#160;B<br/><br/>C<br/></p></body></html>');
  const imported = await importBookFromFile(new File([await zip.generateAsync({ type: 'arraybuffer' })], 'lists.epub'));
  const chapter = imported.chapters[0];
  assert.deepEqual(chapter.paragraphs, ['First part.', 'Second part.', 'Nested item.', 'Next item.', '\nA\u00a0B\n\nC\n', 'Plain body text.']);
  const paragraphs = readerBlocksForChapter(chapter.paragraphs, chapter.readerBlocks).filter((block) => block.type === 'paragraph');
  assert.deepEqual(paragraphs.slice(0, 4).map((block) => block.listMarker), ['3.', '', '•', '4.']);
  assert.equal(paragraphs[2].style?.marginInlineStart, '3em');
  assert.equal(paragraphs[4].content.filter((part) => part.type === 'text' && part.text === '\n').length, 4);
});

test('EPUB renders a linear navigation document and follows links into supplementary spine content', async () => {
  const zip = await JSZip.loadAsync(await (await book({})).arrayBuffer());
  zip.file('OPS/book.opf', (await zip.file('OPS/book.opf')!.async('string')).replace('idref="nav" linear="no"', 'idref="nav"'));
  zip.file('OPS/nav.xhtml', '<html><body><nav><p>Visible contents.</p></nav><p>Publisher introduction.</p></body></html>');
  zip.file('Text/first chapter.xhtml', '<html><body><p>Prose <a href="../OPS/missing.xhtml#note">footnote</a>.</p></body></html>');
  zip.file('OPS/missing.xhtml', '<html><body><h2 id="note">Note heading</h2><p>Supplementary note.</p></body></html>');
  const imported = await importBookFromFile(new File([await zip.generateAsync({ type: 'arraybuffer' })], 'notes.epub'));
  assert.deepEqual(imported.chapters[0].paragraphs.slice(0, 2), ['Visible contents.', 'Publisher introduction.']);
  assert.equal(imported.chapters[1].linear, false);
  const target = 'reader-epub-OPS%2Fmissing.xhtml--note';
  assert.equal(readerAnchorChapter(imported.chapters, target), 2);
  assert.equal(imported.chapters[0].readerBlocks?.some((block) => block.type === 'paragraph' && block.content.some((part) => part.type === 'text' && part.href === `#${target}`)), true);
});

test('EPUB CSS imports and charset declarations preserve cascade order and media filtering', async () => {
  const zip = await JSZip.loadAsync(await (await book({})).arrayBuffer());
  zip.file('Text/first chapter.xhtml', '<html><head><link rel="stylesheet" href="book.css"/><style>p { color: green }</style></head><body><p>Styled paragraph.</p></body></html>');
  zip.file('Text/book.css', '@charset "UTF-8"; @import "base.css"; @import "missing-print.css" print; p { color: red }');
  zip.file('Text/base.css', '@import "book.css"; p { color: blue; text-align: center }');
  const imported = await importBookFromFile(new File([await zip.generateAsync({ type: 'arraybuffer' })], 'css.epub'));
  const paragraph = imported.chapters[0].readerBlocks?.find((block) => block.type === 'paragraph');
  assert.equal(paragraph?.type === 'paragraph' && paragraph.style?.color, 'green');
  assert.equal(paragraph?.type === 'paragraph' && paragraph.style?.textAlign, 'center');
});

test('EPUB chapter boundaries preserve leading images in the document they introduce', async () => {
  const zip = await JSZip.loadAsync(await (await navigationBook(navDocument('<li><a href="../Text/a.xhtml">One</a></li><li><a href="../Text/b.xhtml">Two</a></li>'))).arrayBuffer());
  zip.file('OPS/Text/b.xhtml', '<html><body><img src="scene.png" alt="Next chapter opening"/><h1>Two</h1><p>Second chapter.</p></body></html>');
  const imported = await importBookFromFile(new File([await zip.generateAsync({ type: 'arraybuffer' })], 'image-boundary.epub'));
  assert.equal(imported.chapters[0].readerBlocks?.some((block) => block.type === 'image'), false);
  assert.equal(imported.chapters[1].readerBlocks?.[0].type, 'image');
  assert.equal(chapterTitleForReader(imported.chapters[1], 2), null);
});

test('EPUB source title paragraphs are retained even when navigation labels use different wording', async () => {
  const zip = await JSZip.loadAsync(await (await navigationBook(navDocument('<li><a href="../Text/a.xhtml">Chapter One</a></li>'))).arrayBuffer());
  zip.file('OPS/Text/a.xhtml', '<html><body><p style="font-size:2em;text-align:center"><em>1</em></p><p>Opening prose.</p></body></html>');
  const imported = await importBookFromFile(new File([await zip.generateAsync({ type: 'arraybuffer' })], 'paragraph-title.epub'));
  const chapter = imported.chapters[0];
  assert.equal(chapterTitleForReader(chapter, 1), null);
  assert.equal(chapter.paragraphs[0], '1');
  const first = readerBlocksForChapter(chapter.paragraphs, chapter.readerBlocks)[0];
  assert.equal(first.type === 'paragraph' && first.style?.fontSize, '2em');
});

test('EPUB preserves repeated spine documents and resolves navigation to their first occurrence', async () => {
  const zip = await JSZip.loadAsync(await (await navigationBook(navDocument('<li><a href="../Text/a.xhtml#one">Opening</a></li>'))).arrayBuffer());
  const opf = await zip.file('OPS/book.opf')?.async('string');
  assert.ok(opf);
  zip.file('OPS/book.opf', opf.replace('</spine>', '<itemref idref="a"/></spine>'));
  const imported = await importBookFromFile(new File([await zip.generateAsync({ type: 'arraybuffer' })], 'repeated.epub'));
  assert.equal(imported.chapters.flatMap((chapter) => chapter.paragraphs).filter((paragraph) => paragraph === 'First heading').length, 2);
  assert.equal(readerAnchorChapter(imported.chapters, 'reader-epub-OPS%2FText%2Fa.xhtml--one'), 2);
});
