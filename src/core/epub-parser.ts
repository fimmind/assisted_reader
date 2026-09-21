import JSZip from 'jszip';
import type { BookChapter } from './types';

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const elements = (node: Document | Element, name: string) =>
  Array.from(node.getElementsByTagNameNS('*', name));

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (elements(doc, 'parsererror').length) throw new Error('Invalid EPUB XML.');
  return doc;
}

function resolvePath(base: string, href: string): string {
  const url = new URL(href, new URL(base, 'https://epub.invalid/'));
  if (url.origin !== 'https://epub.invalid') throw new Error('External EPUB content is not supported.');
  return decodeURIComponent(url.pathname.slice(1));
}

// Walk blocks in document order, retaining lists, headings and div-based prose
// without duplicating text from nested containers or executing book markup.
function chapterContent(markup: string, index: number): BookChapter {
  const doc = new DOMParser().parseFromString(markup, 'text/html');
  doc.querySelectorAll('script, style, nav, noscript, template, [hidden], [aria-hidden="true"]')
    .forEach((node) => node.remove());
  const heading = doc.body.querySelector('h1, h2');
  const title = normalize(heading?.textContent || doc.title || '') || `Chapter ${index}`;
  const paragraphs: string[] = [];
  let current = '';
  const flush = () => {
    const text = normalize(current);
    if (text) paragraphs.push(text);
    current = '';
  };
  const blocks = new Set(['p', 'div', 'section', 'article', 'blockquote', 'li', 'ul', 'ol',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'tr', 'dl', 'dt', 'dd', 'hr']);
  const visit = (node: Node) => {
    if (node.nodeType === 3) { current += node.textContent ?? ''; return; }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = element.localName;
    if (element === heading) { flush(); return; }
    if (tag === 'br') { flush(); return; }
    if (blocks.has(tag)) flush();
    for (const child of Array.from(node.childNodes)) visit(child);
    if (tag === 'td' || tag === 'th') current += ' ';
    if (blocks.has(tag)) flush();
  };
  visit(doc.body);
  flush();
  return { title, paragraphs };
}

export async function parseEpubBook(buffer: ArrayBuffer): Promise<{
  title: string;
  author: string;
  chapters: BookChapter[];
}> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const read = async (path: string) => {
      const file = zip.file(path);
      if (!file) throw new Error(`Missing EPUB file: ${path}`);
      return file.async('string');
    };
    const container = parseXml(await read('META-INF/container.xml'));
    const roots = elements(container, 'rootfile');
    const root = roots.find((node) => node.getAttribute('media-type') === 'application/oebps-package+xml') ?? roots[0];
    const opfPath = root?.getAttribute('full-path');
    if (!opfPath) throw new Error('EPUB package path is missing.');
    const opf = parseXml(await read(opfPath));
    const encryptionFile = zip.file('META-INF/encryption.xml');
    const encryptedPaths = new Set(encryptionFile
      ? elements(parseXml(await encryptionFile.async('string')), 'CipherReference')
        .map((node) => resolvePath('', node.getAttribute('URI') ?? ''))
      : []);
    const metadata = elements(opf, 'metadata')[0];
    const title = normalize(metadata ? elements(metadata, 'title')[0]?.textContent ?? '' : '');
    const author = metadata ? elements(metadata, 'creator').map((node) => normalize(node.textContent ?? '')).filter(Boolean).join(', ') : '';
    const manifest = new Map(elements(opf, 'item').map((item) => [item.getAttribute('id'), item]));
    const chapters: BookChapter[] = [];
    for (const ref of elements(opf, 'itemref')) {
      if (ref.getAttribute('linear') === 'no') continue;
      const item = manifest.get(ref.getAttribute('idref'));
      const href = item?.getAttribute('href');
      if (!item || !href) throw new Error('EPUB spine references a missing chapter.');
      if ((item.getAttribute('properties') ?? '').split(/\s+/).includes('nav')) continue;
      const mediaType = item.getAttribute('media-type');
      if (mediaType !== 'application/xhtml+xml' && mediaType !== 'text/html') {
        throw new Error(`Unsupported EPUB chapter format: ${mediaType}`);
      }
      const path = resolvePath(opfPath, href);
      if (encryptedPaths.has(path)) throw new Error('DRM-protected EPUB chapters are not supported. Please import an unlocked copy.');
      const chapter = chapterContent(await read(path), chapters.length + 1);
      if (chapter.paragraphs.length) chapters.push(chapter);
    }
    if (!chapters.length) throw new Error('No readable chapters found. Image-only and DRM-protected EPUBs are not supported.');
    return { title, author, chapters };
  } catch (error) {
    throw new Error(`Could not import EPUB: ${error instanceof Error ? error.message : 'Invalid book.'}`);
  }
}
