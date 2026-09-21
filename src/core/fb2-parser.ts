import type { BookChapter } from './types';

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const children = (node: Element, name: string) => Array.from(node.children).filter((child) => child.localName === name);
const child = (node: Element, name: string) => children(node, name)[0];
const content = (node?: Element) => normalize(node?.textContent ?? '');

function decodeXml(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0x3c && bytes[1] === 0) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff || bytes[0] === 0 && bytes[1] === 0x3c) encoding = 'utf-16be';
  else {
    const declaration = new TextDecoder().decode(bytes.subarray(0, 256));
    encoding = declaration.match(/^\uFEFF?\s*<\?xml\s[^?]*encoding\s*=\s*["']([^"']+)["']/i)?.[1] ?? encoding;
  }
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

export function parseFb2Book(buffer: ArrayBuffer): { title: string; author: string; chapters: BookChapter[] } {
  try {
    const xml = decodeXml(buffer);
    if (/<!DOCTYPE/i.test(xml)) throw new Error('FB2 documents with a DTD are not supported.');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagNameNS('*', 'parsererror').length || doc.documentElement.localName !== 'FictionBook') {
      throw new Error('Invalid FictionBook XML.');
    }
    const root = doc.documentElement;
    const description = child(root, 'description');
    const info = description && child(description, 'title-info');
    const title = info ? content(child(info, 'book-title')) : '';
    const author = info ? children(info, 'author').map((node) => {
      const name = ['first-name', 'middle-name', 'last-name'].map((part) => content(child(node, part))).filter(Boolean).join(' ');
      return name || content(child(node, 'nickname'));
    }).filter(Boolean).join(', ') : '';
    const chapters: BookChapter[] = [];
    const parseSection = (section: Element, fallback: string) => {
      const sectionTitle = child(section, 'title');
      const titleParts = sectionTitle ? children(sectionTitle, 'p').map((node) => content(node)).filter(Boolean) : [];
      const sectionName = titleParts.join(' ') || content(sectionTitle) || fallback;
      let paragraphs: string[] = [];
      const flush = () => {
        if (paragraphs.length) chapters.push({ title: sectionName, paragraphs });
        paragraphs = [];
      };
      const visit = (node: Element) => {
        if (node === sectionTitle || ['image', 'binary', 'empty-line'].includes(node.localName)) return;
        if (node.localName === 'section') {
          flush();
          parseSection(node, `Chapter ${chapters.length + 1}`);
        } else if (['p', 'v', 'subtitle', 'text-author', 'tr'].includes(node.localName)) {
          const text = node.localName === 'tr'
            ? Array.from(node.children).map((cell) => content(cell)).join(' ')
            : content(node);
          if (text) paragraphs.push(text);
        } else {
          for (const nested of Array.from(node.children)) visit(nested);
        }
      };
      for (const node of Array.from(section.children)) visit(node);
      flush();
    };
    for (const body of children(root, 'body')) {
      if (body.getAttribute('name')?.toLowerCase() === 'notes') continue;
      parseSection(body, `Chapter ${chapters.length + 1}`);
    }
    if (!chapters.length) throw new Error('No readable chapters found.');
    return { title, author, chapters };
  } catch (error) {
    throw new Error(`Could not import FB2: ${error instanceof Error ? error.message : 'Invalid book.'}`);
  }
}
