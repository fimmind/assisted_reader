import { readFile, writeFile } from 'node:fs/promises';
import JSZip from 'jszip';

// Keep the original text as the editable source for the bundled EPUB.
const text = await readFile(new URL('../data/hitchhikers_guide.txt', import.meta.url), 'utf8');
const headings = [...text.matchAll(/^[\t ]*((?:chapter|part)[\t ]+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)(?:[\t ]*[:.\-]?[\t ]+[^\r\n]*)?)[\t ]*\r?$/gim)];
const paragraphs = (value) => value.split(/\n\s*\n+/).map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
const chapters = [
  { title: 'Front matter', paragraphs: paragraphs(text.slice(0, headings[0]?.index ?? text.length)) },
  ...headings.map((heading, index) => ({
    title: heading[1].trim(),
    paragraphs: paragraphs(text.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? text.length)),
  })),
].filter((chapter) => chapter.paragraphs.length);
const escapeXml = (value) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
const zip = new JSZip();
const date = new Date('2000-01-01T00:00:00Z');
const add = (name, content, options = {}) => zip.file(name, content, { date, ...options });
add('mimetype', 'application/epub+zip', { compression: 'STORE' });
add('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
add('EPUB/package.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:easeword:seed-hitchhiker</dc:identifier><dc:title>The Hitchhiker's Guide to the Galaxy</dc:title><dc:creator>Douglas Adams</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">2000-01-01T00:00:00Z</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((_, index) => `<item id="chapter-${index}" href="chapter-${index}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest>
<spine>${chapters.map((_, index) => `<itemref idref="chapter-${index}"/>`).join('')}</spine></package>`);
add('EPUB/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en"><head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol>${chapters.map((chapter, index) => `<li><a href="chapter-${index}.xhtml">${escapeXml(chapter.title)}</a></li>`).join('')}</ol></nav></body></html>`);
chapters.forEach((chapter, index) => {
  // Titles live in navigation, keeping analysis offsets and saved positions identical to TXT.
  add(`EPUB/chapter-${index}.xhtml`, `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><title>${escapeXml(chapter.title)}</title></head><body>${chapter.paragraphs.map((paragraph) => `<p>${escapeXml(paragraph)}</p>`).join('\n')}</body></html>`);
});
await writeFile(new URL('../data/hitchhikers_guide.epub', import.meta.url), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`Built bundled Hitchhiker EPUB (${chapters.length} chapters).`);
