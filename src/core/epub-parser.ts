import JSZip from 'jszip';
import type { BookChapter } from './types';

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const IMAGE_MIME: Record<string, string> = {
  'image/jpeg': 'image/jpeg', 'image/png': 'image/png', 'image/gif': 'image/gif', 'image/webp': 'image/webp',
};
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 100 * 1024 * 1024;
type ContentBlock = { type: 'text'; text: string } | { type: 'image'; href: string; alt: string; src?: string };
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
function chapterContent(markup: string, index: number, mediaType: string): { blocks: ContentBlock[]; anchors: Map<string, number> } {
  let doc: Document;
  if (mediaType === 'application/xhtml+xml') {
    // XHTML permits <title/> and <script/>. HTML parsing treats these as
    // unclosed tags and can swallow the entire chapter into the head.
    try {
      doc = parseXml(markup);
    } catch {
      // Some older EPUBs label HTML (e.g. unescaped entities) as XHTML.
      doc = new DOMParser().parseFromString(markup, 'text/html');
    }
  } else {
    doc = new DOMParser().parseFromString(markup, 'text/html');
  }
  doc.querySelectorAll('script, style, nav, noscript, template, [hidden], [aria-hidden="true"]')
    .forEach((node) => node.remove());
  const body = elements(doc, 'body')[0];
  if (!body) throw new Error(`EPUB chapter ${index} has no readable body.`);
  const blocks: ContentBlock[] = [];
  const anchors = new Map<string, number>();
  let current = '';
  const flush = () => {
    const text = normalize(current);
    if (text) blocks.push({ type: 'text', text });
    current = '';
  };
  const blockTags = new Set(['p', 'div', 'section', 'article', 'blockquote', 'li', 'ul', 'ol',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'tr', 'dl', 'dt', 'dd', 'hr']);
  const visit = (node: Node) => {
    if (node.nodeType === 3 || node.nodeType === 4) { current += node.textContent ?? ''; return; }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = element.localName;
    const anchor = element.getAttribute('id') || element.getAttribute('xml:id')
      || (tag === 'a' ? element.getAttribute('name') : null);
    if (anchor) {
      // Inline anchors belong to their containing paragraph. Flushing here
      // would split its text merely because the TOC links into it.
      if (blockTags.has(tag)) flush();
      if (!anchors.has(anchor)) anchors.set(anchor, blocks.length);
    }
    if (tag === 'img' || tag === 'image') {
      flush();
      const href = element.getAttribute('src') || element.getAttribute('href')
        || element.getAttribute('xlink:href');
      if (href) blocks.push({ type: 'image', href, alt: normalize(element.getAttribute('alt') ?? '') });
      return;
    }
    if (tag === 'br') { flush(); return; }
    if (blockTags.has(tag)) flush();
    for (const child of Array.from(node.childNodes)) visit(child);
    if (tag === 'td' || tag === 'th') current += ' ';
    if (blockTags.has(tag)) flush();
  };
  visit(body);
  flush();
  return { blocks, anchors };
}

interface TocEntry { title: string; path: string; fragment: string }
interface TocTable { entries: TocEntry[]; skippedEntry: boolean }
interface ContentFile { path: string; blocks: ContentBlock[]; anchors: Map<string, number> }

function tocEntry(base: string, href: string | null, title: string): TocEntry {
  if (!href || !normalize(title)) throw new Error('Invalid table of contents entry.');
  const url = new URL(href, new URL(base, 'https://epub.invalid/'));
  return { title: normalize(title), path: resolvePath(base, href), fragment: decodeURIComponent(url.hash.slice(1)) };
}

async function readTablesOfContents(opf: Document, opfPath: string, manifest: Map<string | null, Element>, read: (path: string) => Promise<string>): Promise<TocTable[]> {
  const tables: TocTable[] = [];
  const navItems = [...manifest.values()].filter((item) => (item.getAttribute('properties') ?? '').split(/\s+/).includes('nav'));
  const ncxId = elements(opf, 'spine')[0]?.getAttribute('toc');
  const ncx = manifest.get(ncxId ?? null)
    ?? [...manifest.values()].find((item) => item.getAttribute('media-type') === 'application/x-dtbncx+xml');
  for (const item of [...navItems, ...(ncx ? [ncx] : [])]) {
    try {
      const href = item.getAttribute('href');
      if (!href) continue;
      const path = resolvePath(opfPath, href);
      const doc = parseXml(await read(path));
      if (item === ncx) {
        const map = elements(doc, 'navMap')[0];
        if (!map) continue;
        const entries: TocEntry[] = [];
        let skippedEntry = false;
        for (const point of elements(map, 'navPoint')) {
          const direct = (name: string) => Array.from(point.children).find((node) => node.localName === name);
          try {
            entries.push(tocEntry(path, direct('content')?.getAttribute('src') ?? null, direct('navLabel')?.textContent ?? ''));
          } catch { skippedEntry = true; }
        }
        tables.push({ entries, skippedEntry });
      } else {
        const toc = elements(doc, 'nav').find((nav) =>
          (nav.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ?? nav.getAttribute('epub:type') ?? '').split(/\s+/).includes('toc'));
        if (toc) {
          const entries: TocEntry[] = [];
          let skippedEntry = false;
          for (const link of elements(toc, 'a')) {
            try { entries.push(tocEntry(path, link.getAttribute('href'), link.textContent ?? '')); }
            catch { skippedEntry = true; }
          }
          tables.push({ entries, skippedEntry });
        }
      }
    } catch {
      // Broken navigation must not prevent importing otherwise readable text.
    }
  }
  return tables;
}

function groupChapters(files: ContentFile[], tables: TocTable[]): BookChapter[] {
  const blocks: ContentBlock[] = [];
  const locations = new Map<string, { offset: number; file: ContentFile }>();
  for (const file of files) {
    locations.set(file.path, { offset: blocks.length, file });
    blocks.push(...file.blocks);
  }
  const makeChapter = (title: string, start: number, end: number): BookChapter => {
    const paragraphs: string[] = [];
    const images: NonNullable<BookChapter['images']> = [];
    for (const block of blocks.slice(start, end)) {
      if (block.type === 'text') paragraphs.push(block.text);
      else if (block.src) images.push({ beforeParagraph: paragraphs.length, src: block.src, alt: block.alt });
    }
    return images.length ? { title, paragraphs, images } : { title, paragraphs };
  };
  const readable = (chapter: BookChapter) => chapter.paragraphs.length > 0 || !!chapter.images?.length;
  let partialChapters: BookChapter[] | undefined;
  for (const table of tables) {
    const boundaries: Array<{ title: string; offset: number }> = [];
    let skippedEntry = table.skippedEntry;
    for (const entry of table.entries) {
      const location = locations.get(entry.path);
      const local = entry.fragment ? location?.file.anchors.get(entry.fragment) : 0;
      if (!location || local === undefined) { skippedEntry = true; continue; }
      const offset = location.offset + local;
      const previous = boundaries[boundaries.length - 1];
      if (previous && offset < previous.offset) { skippedEntry = true; continue; }
      // Parent and child TOC entries can point to the same opening paragraph.
      if (previous?.offset === offset) { previous.title = entry.title; continue; }
      boundaries.push({ title: entry.title, offset });
    }
    if (!boundaries.length) continue;
    if (boundaries[0].offset > 0) boundaries.unshift({ title: 'Front matter', offset: 0 });
    const chapters = boundaries.map((boundary, index) =>
      makeChapter(boundary.title, boundary.offset, boundaries[index + 1]?.offset ?? blocks.length))
      .filter(readable);
    if (!chapters.length) continue;
    // Prefer a complete NCX over a damaged EPUB 3 nav, but still use the
    // readable nav entries if no complete table of contents is available.
    if (!skippedEntry) return chapters;
    partialChapters ??= chapters;
  }
  return partialChapters ?? [makeChapter('Chapter 1', 0, blocks.length)];
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
    const imageMimeByPath = new Map<string, string>();
    for (const item of manifest.values()) {
      const href = item.getAttribute('href');
      const mime = IMAGE_MIME[item.getAttribute('media-type') ?? ''];
      if (href && mime) {
        try { imageMimeByPath.set(resolvePath(opfPath, href), mime); }
        catch { /* External images are not imported. */ }
      }
    }
    const imageCache = new Map<string, string>();
    let totalImageBytes = 0;
    const imageSource = async (chapterPath: string, href: string): Promise<string | undefined> => {
      let path: string;
      try { path = resolvePath(chapterPath, href); }
      catch { return undefined; }
      const mime = imageMimeByPath.get(path);
      if (!mime) return undefined;
      if (encryptedPaths.has(path)) throw new Error(`DRM-protected EPUB image is not supported: ${path}`);
      const cached = imageCache.get(path);
      if (cached) return cached;
      const image = zip.file(path);
      if (!image) throw new Error(`Missing EPUB image: ${path}`);
      const bytes = await image.async('uint8array');
      if (bytes.length > MAX_IMAGE_BYTES || totalImageBytes + bytes.length > MAX_TOTAL_IMAGE_BYTES) {
        throw new Error('EPUB images exceed the supported size limit.');
      }
      totalImageBytes += bytes.length;
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      }
      const src = `data:${mime};base64,${btoa(binary)}`;
      imageCache.set(path, src);
      return src;
    };
    const spineRefs = elements(opf, 'itemref');
    if (!spineRefs.length) throw new Error('Could not read the EPUB chapter list.');
    const tables = await readTablesOfContents(opf, opfPath, manifest, read);
    const files: ContentFile[] = [];
    for (const ref of spineRefs) {
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
      const content = chapterContent(await read(path), files.length + 1, mediaType);
      for (const block of content.blocks) {
        if (block.type === 'image') block.src = await imageSource(path, block.href);
      }
      files.push({ path, ...content });
    }
    if (!files.some((file) => file.blocks.some((block) => block.type === 'text' || !!block.src))) {
      throw new Error('No readable text or supported images could be extracted from this EPUB.');
    }
    const chapters = groupChapters(files, tables);
    return { title, author, chapters };
  } catch (error) {
    throw new Error(`Could not import EPUB: ${error instanceof Error ? error.message : 'Invalid book.'}`);
  }
}
