import type { BookChapter, ReaderContentBlock, ReaderContentStyle, ReaderInlineMark, ReaderParagraphBlock } from './types';
import { normalizeInlineParts, type RawInlinePart } from './rich-content';
import { readerCssRules, readerElementStyle, type ReaderCssRule } from './reader-styles';

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
const children = (node: Element, name: string): Element[] => Array.from(node.children).filter((nested) => nested.localName === name);
const child = (node: Element, name: string): Element | undefined => children(node, name)[0];
const content = (node: Element | undefined): string => normalize(node?.textContent ?? '');
const anchorId = (id: string): string => `reader-fb2-${encodeURIComponent(id)}`;

interface Fb2Presentation {
  blockType: ReaderParagraphBlock['blockType'];
  level?: number;
  style: ReaderContentStyle;
}

interface Fb2Resources {
  binaries: Map<string, string>;
  rules: ReaderCssRule[];
}

function fb2Marks(tag: string, inherited: ReaderInlineMark[]): ReaderInlineMark[] {
  const mark: ReaderInlineMark | null = tag === 'strong' ? 'strong'
    : tag === 'emphasis' ? 'emphasis'
      : tag === 'strikethrough' ? 'strike'
        : tag === 'sub' ? 'subscript'
          : tag === 'sup' ? 'superscript'
            : tag === 'code' ? 'code' : null;
  return mark && !inherited.includes(mark) ? [...inherited, mark] : inherited;
}

function fb2Image(element: Element, binaries: Map<string, string>): Extract<RawInlinePart, { type: 'image' }> {
  const href = element.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? element.getAttribute('href');
  if (!href?.startsWith('#') || href.length === 1) throw new Error(`FB2 image has no local binary reference: href=${href}`);
  const id = href.slice(1);
  const src = binaries.get(id);
  if (!src) throw new Error(`FB2 image references missing binary data: id=${id}`);
  return { type: 'image', src, alt: element.getAttribute('alt') ?? '', ...(element.getAttribute('title') ? { title: element.getAttribute('title')! } : {}), style: { maxWidth: '100%', height: 'auto' } };
}

function fb2Inline(
  node: Node,
  marks: ReaderInlineMark[],
  inherited: ReaderContentStyle,
  blockStyle: ReaderContentStyle,
  href: string | undefined,
  resources: Fb2Resources,
): RawInlinePart[] {
  if (node.nodeType === 3 || node.nodeType === 4) {
    const style = Object.fromEntries(Object.entries(inherited).filter(([property, value]) => blockStyle[property as keyof ReaderContentStyle] !== value));
    return [{ type: 'text', text: node.textContent ?? '', marks, ...(Object.keys(style).length ? { style } : {}), ...(href ? { href } : {}) }];
  }
  if (node.nodeType !== 1) return [];
  const element = node as Element;
  if (element.localName === 'image') return [fb2Image(element, resources.binaries)];
  const style = readerElementStyle(element, inherited, resources.rules);
  if (style.display === 'none') return [];
  const rawHref = element.localName === 'a'
    ? element.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? element.getAttribute('href') : null;
  const link = rawHref?.startsWith('#') ? `#${anchorId(rawHref.slice(1))}`
    : rawHref && /^(https?:|mailto:|tel:)/i.test(rawHref) ? rawHref : href;
  return Array.from(element.childNodes).flatMap((nested) => fb2Inline(nested, fb2Marks(element.localName, marks), style, blockStyle, link, resources));
}

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
    const root = doc.documentElement;
    if (doc.getElementsByTagNameNS('*', 'parsererror').length || root.localName !== 'FictionBook'
      || root.namespaceURI && root.namespaceURI !== 'http://www.gribuser.ru/xml/fictionbook/2.0') {
      throw new Error('Invalid FictionBook XML.');
    }
    const description = child(root, 'description');
    const info = description && child(description, 'title-info');
    const title = info ? content(child(info, 'book-title')) : '';
    const author = info ? children(info, 'author').map((node) => {
      const name = ['first-name', 'middle-name', 'last-name'].map((part) => content(child(node, part))).filter(Boolean).join(' ');
      return name || content(child(node, 'nickname'));
    }).filter(Boolean).join(', ') : '';
    // FictionBook style attributes and <style name="..."> name classes, rather than containing CSS declarations.
    for (const element of Array.from(root.getElementsByTagNameNS('*', '*'))) {
      const name = element.localName === 'style' ? element.getAttribute('name') : element.getAttribute('style');
      if (name && !name.includes(':')) element.setAttribute('class', name);
    }
    const rules = children(root, 'stylesheet').filter((node) => node.getAttribute('type') === 'text/css')
      .flatMap((node) => readerCssRules(node.textContent ?? '')).map((rule, order) => ({ ...rule, order }));
    const binaries = new Map<string, string>();
    for (const binary of children(root, 'binary')) {
      const id = binary.getAttribute('id');
      const mimeType = binary.getAttribute('content-type') ?? '';
      const encoded = (binary.textContent ?? '').replace(/\s+/g, '');
      if (!id || !/^image\/[\w.+-]+$/.test(mimeType) || !encoded) continue;
      if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error(`Invalid FB2 image binary data: id=${id}`);
      if (binaries.has(id)) throw new Error(`Duplicate FB2 binary id: id=${id}`);
      binaries.set(id, `data:${mimeType};base64,${encoded}`);
    }
    const resources: Fb2Resources = { binaries, rules };
    const chapters: BookChapter[] = [];
    const parseSection = (section: Element, fallback: string, linear: boolean, inherited: ReaderContentStyle): void => {
      const sectionTitle = child(section, 'title');
      const sectionName = sectionTitle ? children(sectionTitle, 'p').map((node) => content(node)).filter(Boolean).join(' ') || fallback : fallback;
      let paragraphs: string[] = [];
      let readerBlocks: ReaderContentBlock[] = [];
      let pendingAnchors: string[] = section.getAttribute('id') ? [anchorId(section.getAttribute('id')!)] : [];
      let isContinuation = false;
      const flush = (): void => {
        if (!readerBlocks.some((block) => block.type === 'paragraph' || block.type === 'image')) return;
        if (pendingAnchors.length) readerBlocks.push({ type: 'spacer', afterParagraphIndex: paragraphs.length, anchorIds: pendingAnchors, style: { height: '0' } });
        chapters.push({ title: sectionName, paragraphs, readerBlocks, linear,
          titlePresentation: isContinuation ? 'continuation' : 'content' });
        paragraphs = [];
        readerBlocks = [];
        pendingAnchors = [];
        isContinuation = true;
      };
      const visit = (node: Element, presentation: Fb2Presentation): void => {
        const tag = node.localName;
        const style = readerElementStyle(node, presentation.style, rules);
        if (style.display === 'none') return;
        if (tag === 'section') {
          flush();
          parseSection(node, `Chapter ${chapters.length + 1}`, linear, style);
          isContinuation = true;
          return;
        }
        const id = node.getAttribute('id');
        if (id) pendingAnchors.push(anchorId(id));
        if (['p', 'v', 'subtitle', 'text-author', 'tr', 'date'].includes(tag)) {
          const parts: RawInlinePart[] = tag === 'tr'
            ? Array.from(node.children).flatMap((cell) => [...fb2Inline(cell, [], style, style, undefined, resources), { type: 'text' as const, text: ' ', marks: [] }])
            : Array.from(node.childNodes).flatMap((nested) => fb2Inline(nested, [], style, style, undefined, resources));
          pendingAnchors.push(...Array.from(node.getElementsByTagNameNS('*', '*')).flatMap((nested) => nested.getAttribute('id') ? [anchorId(nested.getAttribute('id')!)] : []));
          const normalized = normalizeInlineParts(parts, false);
          if (normalized.text) {
            const block: ReaderParagraphBlock = {
              type: 'paragraph', paragraphIndex: paragraphs.length,
              blockType: tag === 'v' ? 'verse' : tag === 'subtitle' ? 'heading' : tag === 'tr' ? 'table-row'
                : ['text-author', 'date'].includes(tag) ? 'caption' : presentation.blockType,
              ...(tag === 'subtitle' ? { level: 2 } : presentation.level ? { level: presentation.level } : {}),
              ...(Object.keys(style).length ? { style } : {}), ...(pendingAnchors.length ? { anchorIds: pendingAnchors } : {}), content: normalized.content,
            };
            paragraphs.push(normalized.text);
            readerBlocks.push(block);
            pendingAnchors = [];
          } else {
            for (const part of normalized.content) {
              if (part.type === 'image') readerBlocks.push({ ...part, afterParagraphIndex: paragraphs.length, ...(pendingAnchors.length ? { anchorIds: pendingAnchors } : {}) });
            }
            if (normalized.content.some((part) => part.type === 'image')) pendingAnchors = [];
          }
        } else if (tag === 'image' || tag === 'empty-line') {
          readerBlocks.push(tag === 'image'
            ? { ...fb2Image(node, binaries), afterParagraphIndex: paragraphs.length, ...(pendingAnchors.length ? { anchorIds: pendingAnchors } : {}) }
            : { type: 'spacer', afterParagraphIndex: paragraphs.length, style: { height: '1em' }, ...(pendingAnchors.length ? { anchorIds: pendingAnchors } : {}) });
          pendingAnchors = [];
        } else {
          const blockType = tag === 'title' ? 'heading' : ['cite', 'epigraph'].includes(tag) ? 'blockquote' : presentation.blockType;
          const level = tag === 'title' ? 1 : presentation.level;
          let stanzaCount = 0;
          for (const nested of Array.from(node.children)) {
            if (nested.localName === 'stanza' && stanzaCount++ > 0) readerBlocks.push({ type: 'spacer', afterParagraphIndex: paragraphs.length, style: { height: '1em' } });
            visit(nested, { blockType, level, style });
          }
        }
      };
      const style = readerElementStyle(section, inherited, rules);
      for (const node of Array.from(section.children)) visit(node, { blockType: 'paragraph', style });
      flush();
    };
    children(root, 'body').forEach((body, index) => parseSection(body, `Chapter ${chapters.length + 1}`, index === 0, {}));
    if (!chapters.length) throw new Error('No readable chapters found.');
    return { title, author, chapters };
  } catch (error) {
    throw new Error(`Could not import FB2: ${error instanceof Error ? error.message : 'Invalid book.'}`);
  }
}
