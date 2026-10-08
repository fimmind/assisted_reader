import JSZip from 'jszip';
import type {
  BookChapter,
  ReaderContentBlock,
  ReaderContentStyle,
  ReaderInlineMark,
  ReaderParagraphBlock,
} from './types';
import {
  mergeReaderStyles,
  normalizeInlineParts,
  parseStyleDeclarations,
  type RawInlinePart,
} from './rich-content';

import { readerCssRules, readerElementStyle, readerMediaMatches } from './reader-styles';

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const elements = (node: Document | Element, name: string) =>
  Array.from(node.getElementsByTagNameNS('*', name));

function semanticMarks(tag: string, inherited: ReaderInlineMark[]): ReaderInlineMark[] {
  const mark: ReaderInlineMark | null = ['b', 'strong'].includes(tag) ? 'strong'
    : ['i', 'em', 'cite', 'dfn', 'var'].includes(tag) ? 'emphasis'
      : tag === 'u' || tag === 'ins' ? 'underline'
        : ['s', 'strike', 'del'].includes(tag) ? 'strike'
          : tag === 'sub' ? 'subscript'
            : tag === 'sup' ? 'superscript'
              : ['code', 'kbd', 'samp', 'tt'].includes(tag) ? 'code'
                : tag === 'mark' ? 'mark'
                  : tag === 'small' ? 'small'
                    : tag === 'big' ? 'big' : null;
  return mark && !inherited.includes(mark) ? [...inherited, mark] : inherited;
}

function epubAnchorId(path: string, fragment: string): string {
  return `reader-epub-${encodeURIComponent(path)}--${encodeURIComponent(fragment)}`;
}

function safeLinkHref(path: string, rawHref: string | null): string | undefined {
  if (rawHref === null) return undefined;
  const url = new URL(rawHref, new URL(path, 'https://epub.invalid/'));
  if (url.origin === 'https://epub.invalid') {
    return `#${epubAnchorId(decodeURIComponent(url.pathname.slice(1)), decodeURIComponent(url.hash.slice(1)))}`;
  }
  return /^(https?:|mailto:|tel:)$/i.test(url.protocol) ? rawHref.trim() : undefined;
}

function imageMimeType(path: string, mediaTypes: Map<string, string>): string {
  const declared = mediaTypes.get(path);
  if (declared?.startsWith('image/')) return declared;
  const extension = path.split('.').pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    avif: 'image/avif', bmp: 'image/bmp', gif: 'image/gif', jpeg: 'image/jpeg', jpg: 'image/jpeg',
    png: 'image/png', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff', webp: 'image/webp',
  };
  const mimeType = extension ? mimeTypes[extension] : undefined;
  if (!mimeType) throw new Error(`Unsupported EPUB image type: path=${path}`);
  return mimeType;
}

async function epubImageDataUri(
  zip: JSZip,
  basePath: string,
  rawHref: string,
  mediaTypes: Map<string, string>,
): Promise<string> {
  if (/^data:image\//i.test(rawHref)) return rawHref;
  const url = new URL(rawHref, new URL(basePath, 'https://epub.invalid/'));
  if (url.origin !== 'https://epub.invalid') throw new Error(`External EPUB images are not supported: ${rawHref}`);
  const path = decodeURIComponent(url.pathname.slice(1));
  const file = zip.file(path);
  if (!file) throw new Error(`Missing EPUB image resource: ${path}`);
  const mediaType = imageMimeType(path, mediaTypes);
  const base64 = await file.async('base64');
  return `data:${mediaType};base64,${base64}${url.hash}`;
}

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

interface ParsedChapterContent {
  paragraphs: string[];
  readerBlocks: ReaderContentBlock[];
  anchors: Map<string, number>;
}

interface ParagraphContext {
  blockType: ReaderParagraphBlock['blockType'];
  level?: number;
  listMarker?: string;
  style: ReaderContentStyle;
}

function listMarker(element: Element, style: ReaderContentStyle): string | undefined {
  const parent = element.parentElement;
  const listType = parent?.localName;
  if (!parent || (listType !== 'ol' && listType !== 'ul')) return undefined;
  const siblings = Array.from(parent.children).filter((child) => child.localName === 'li');
  const currentIndex = siblings.indexOf(element);
  const reversed = listType === 'ol' && parent.hasAttribute('reversed');
  const declaredStart = Number(parent.getAttribute('start'));
  let ordinal = Number.isFinite(declaredStart) && parent.hasAttribute('start')
    ? declaredStart
    : reversed ? siblings.length : 1;
  const step = reversed ? -1 : 1;
  for (let index = 0; index <= currentIndex; index += 1) {
    const declaredValue = Number(siblings[index].getAttribute('value'));
    if (siblings[index].hasAttribute('value') && Number.isFinite(declaredValue)) ordinal = declaredValue;
    if (index < currentIndex) ordinal += step;
  }
  const typeAttribute = parent.getAttribute('type');
  const attributeMarker = typeAttribute === 'a' ? 'lower-alpha'
    : typeAttribute === 'A' ? 'upper-alpha'
      : typeAttribute === 'i' ? 'lower-roman'
        : typeAttribute === 'I' ? 'upper-roman'
          : typeAttribute === '1' ? 'decimal'
            : typeAttribute === 'square' ? 'square'
              : typeAttribute === 'circle' ? 'circle' : undefined;
  const markerType = style.listStyleType ?? attributeMarker ?? (listType === 'ol' ? 'decimal' : 'disc');
  if (markerType === 'none') return '';
  if (markerType === 'disc') return '•';
  if (markerType === 'circle') return '◦';
  if (markerType === 'square') return '▪';
  if (markerType === 'lower-alpha' || markerType === 'lower-latin') return `${String.fromCharCode(97 + ((ordinal - 1) % 26))}.`;
  if (markerType === 'upper-alpha' || markerType === 'upper-latin') return `${String.fromCharCode(65 + ((ordinal - 1) % 26))}.`;
  if (markerType === 'lower-roman' || markerType === 'upper-roman') {
    const numerals: Array<[number, string]> = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
    let number = Math.max(1, ordinal);
    let roman = '';
    for (const [value, numeral] of numerals) {
      while (number >= value) { roman += numeral; number -= value; }
    }
    return `${markerType === 'upper-roman' ? roman.toUpperCase() : roman}.`;
  }
  return `${ordinal}.`;
}

function blockTypeFor(tag: string, inherited: ParagraphContext | null): ReaderParagraphBlock['blockType'] {
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'li') return 'list-item';
  if (tag === 'pre') return 'pre';
  if (tag === 'figcaption' || tag === 'caption') return 'caption';
  if (tag === 'tr') return 'table-row';
  if (tag === 'v') return 'verse';
  if (inherited?.blockType === 'blockquote') return 'blockquote';
  return 'paragraph';
}

function blockLevel(tag: string): number | undefined {
  return /^h[1-6]$/.test(tag) ? Number(tag.slice(1)) : undefined;
}

function styleDifference(style: ReaderContentStyle, inherited: ReaderContentStyle): ReaderContentStyle {
  const difference: ReaderContentStyle = {};
  for (const [property, value] of Object.entries(style) as Array<[keyof ReaderContentStyle, string]>) {
    if (inherited[property] !== value) difference[property] = value;
  }
  return difference;
}

async function expandStylesheet(css: string, path: string, zip: JSZip, ancestors: ReadonlySet<string>): Promise<string> {
  const imports = Array.from(css.matchAll(/@import\s+(?:url\(\s*(?:["']([^"']+)["']|([^\s)]+))\s*\)|["']([^"']+)["'])\s*([^;]*);/gi));
  const importedStyles: string[] = [];
  for (const match of imports) {
    if (!readerMediaMatches(match[4])) continue;
    const importedPath = resolvePath(path, match[1] ?? match[2] ?? match[3]);
    // CSS import cycles are ignored by CSS user agents.
    if (ancestors.has(importedPath)) continue;
    const file = zip.file(importedPath);
    if (!file) throw new Error(`Missing imported EPUB stylesheet: source=${path}, path=${importedPath}`);
    importedStyles.push(await expandStylesheet(await file.async('string'), importedPath, zip, new Set([...ancestors, importedPath])));
  }
  return [...importedStyles, css].join('\n');
}

// Walk blocks in document order and retain presentation separately from the text used by NLP.
async function chapterContent(
  markup: string,
  index: number,
  mediaType: string,
  path: string,
  zip: JSZip,
  mediaTypes: Map<string, string>,
): Promise<ParsedChapterContent> {
  let doc: Document;
  if (mediaType === 'application/xhtml+xml') {
    // XHTML permits <title/> and <script/>. HTML parsing treats these as
    // unclosed tags and can swallow the entire chapter into the head.
    try {
      doc = parseXml(markup);
    } catch (error) {
      console.warn('epub-legacy-html-parsing', { path, cause: error instanceof Error ? error.message : String(error) });
      // Some older EPUBs label HTML (e.g. unescaped entities) as XHTML.
      doc = new DOMParser().parseFromString(markup, 'text/html');
    }
  } else {
    doc = new DOMParser().parseFromString(markup, 'text/html');
  }
  const styleText: string[] = [];
  const stylesheetNodes = Array.from(doc.querySelectorAll('style, link[rel~="stylesheet"]'));
  for (const node of stylesheetNodes) {
    if (node.localName === 'style') {
      if ((!node.getAttribute('type') || node.getAttribute('type') === 'text/css') && readerMediaMatches(node.getAttribute('media') ?? '')) styleText.push(await expandStylesheet(node.textContent ?? '', path, zip, new Set()));
      continue;
    }
    if (!readerMediaMatches(node.getAttribute('media') ?? '')) continue;
    const href = node.getAttribute('href');
    if (!href) continue;
    const url = new URL(href, new URL(path, 'https://epub.invalid/'));
    if (url.origin !== 'https://epub.invalid') throw new Error(`External EPUB stylesheets are not supported: href=${href}`);
    const cssPath = decodeURIComponent(url.pathname.slice(1));
    const linkType = node.getAttribute('type')?.split(';')[0].trim().toLowerCase();
    const manifestType = mediaTypes.get(cssPath);
    if (linkType && linkType !== 'text/css') continue;
    if (manifestType && manifestType !== 'text/css') continue;
    if (/\.xpgt$/i.test(cssPath)) continue;
    const cssFile = zip.file(cssPath);
    if (!cssFile) throw new Error(`Missing EPUB stylesheet: ${cssPath}`);
    styleText.push(await expandStylesheet(await cssFile.async('string'), cssPath, zip, new Set([cssPath])));
  }
  doc.querySelectorAll('script, style, noscript, template, [hidden]')
    .forEach((node) => node.remove());
  const body = elements(doc, 'body')[0];
  if (!body) throw new Error(`EPUB chapter ${index} has no readable body.`);
  const paragraphs: string[] = [];
  const readerBlocks: ReaderContentBlock[] = [];
  const anchors = new Map<string, number>();
  const cssRules = styleText.flatMap(readerCssRules).map((rule, order) => ({ ...rule, order }));
  let currentParts: RawInlinePart[] = [];
  let currentContext: ParagraphContext = { blockType: 'paragraph', style: {} };
  let currentAnchorIds: string[] = [];
  let pendingAnchorIds: string[] = [epubAnchorId(path, '')];

  const attachAnchor = (rawAnchor: string | null) => {
    const anchor = rawAnchor?.trim();
    if (!anchor) return;
    if (!anchors.has(anchor)) anchors.set(anchor, readerBlocks.length);
    if (currentParts.some((part) => part.type === 'text' && part.text.length > 0)) currentAnchorIds.push(epubAnchorId(path, anchor));
    else pendingAnchorIds.push(epubAnchorId(path, anchor));
  };

  const flush = () => {
    if (!currentParts.length) return;
    const normalized = normalizeInlineParts(
      currentParts,
      currentContext.blockType === 'pre' || ['pre', 'pre-wrap', 'break-spaces'].includes(currentContext.style.whiteSpace ?? ''),
    );
    if (normalized.text) {
      const paragraphIndex = paragraphs.length;
      paragraphs.push(normalized.text);
      const paragraph: ReaderParagraphBlock = {
        type: 'paragraph',
        paragraphIndex,
        blockType: currentContext.blockType,
        ...(currentContext.level ? { level: currentContext.level } : {}),
        ...(currentContext.listMarker !== undefined ? { listMarker: currentContext.listMarker } : {}),
        ...(currentAnchorIds.length ? { anchorIds: [...new Set(currentAnchorIds)] } : {}),
        ...(Object.keys(currentContext.style).length ? { style: currentContext.style } : {}),
        content: normalized.content,
      };
      readerBlocks.push(paragraph);
    } else {
      for (const part of normalized.content) {
        if (part.type === 'image') readerBlocks.push({ ...part, afterParagraphIndex: paragraphs.length, anchorIds: [...currentAnchorIds] });
      }
    }
    currentParts = [];
    currentAnchorIds = [];
    currentContext = { blockType: 'paragraph', style: {} };
  };

  const walkInline = async (
    node: Node,
    inheritedStyle: ReaderContentStyle,
    blockStyle: ReaderContentStyle,
    inheritedMarks: ReaderInlineMark[],
    inheritedHref: string | undefined,
    inheritedTitle: string | undefined,
  ): Promise<RawInlinePart[]> => {
    if (node.nodeType === 3 || node.nodeType === 4) {
      const text = node.textContent ?? '';
      const style = styleDifference(inheritedStyle, blockStyle);
      return text ? [{ type: 'text', text, marks: inheritedMarks, ...(Object.keys(style).length ? { style } : {}), ...(inheritedHref ? { href: inheritedHref } : {}), ...(inheritedTitle ? { title: inheritedTitle } : {}) }] : [];
    }
    if (node.nodeType !== 1) return [];
    const element = node as Element;
    const tag = element.localName;
    attachAnchor(element.getAttribute('id') || element.getAttribute('xml:id') || (tag === 'a' ? element.getAttribute('name') : null));
    const style = element.localName === 'td' || element.localName === 'th'
      ? mergeReaderStyles(
        parseStyleDeclarations('display:inline-block;min-width:4em;vertical-align:top;padding-inline-end:.75em'),
        readerElementStyle(element, inheritedStyle, cssRules),
      )
      : readerElementStyle(element, inheritedStyle, cssRules);
    if (style.display === 'none') return [];
    const marks = semanticMarks(tag, inheritedMarks);
    if (tag === 'br') return [{ type: 'break', marks, style }];
    if (tag === 'img' || tag === 'image') {
      const source = element.getAttribute('src')
        ?? element.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
        ?? element.getAttribute('href');
      if (!source) throw new Error(`EPUB image has no source: chapter=${index}`);
      const src = await epubImageDataUri(zip, path, source, mediaTypes);
      const alt = element.getAttribute('alt') ?? elements(element, 'title')[0]?.textContent ?? '';
      const imageStyle = mergeReaderStyles(parseStyleDeclarations('max-width:100%;height:auto'), styleDifference(style, blockStyle));
      return [{ type: 'image', src, alt: normalize(alt), ...(element.getAttribute('title') ? { title: element.getAttribute('title')! } : {}), ...(Object.keys(imageStyle).length ? { style: imageStyle } : {}) }];
    }
    const href = tag === 'a' ? safeLinkHref(path, element.getAttribute('href')) ?? inheritedHref : inheritedHref;
    const title = element.getAttribute('title') ?? inheritedTitle;
    const output: RawInlinePart[] = [];
    for (const child of Array.from(node.childNodes)) output.push(...await walkInline(child, style, blockStyle, marks, href, title));
    if (tag === 'td' || tag === 'th') output.push({ type: 'text', text: ' ', marks, style: inheritedStyle });
    return output;
  };

  const paragraphTags = new Set(['p', 'li', 'pre', 'tr', 'dt', 'dd', 'figcaption', 'caption', 'subtitle', 'v', 'text-author']);
  const containerTags = new Set(['div', 'section', 'article', 'nav', 'header', 'footer', 'main', 'aside', 'address', 'hgroup', 'details', 'summary', 'center', 'blockquote', 'ul', 'ol', 'dl', 'figure', 'table', 'tbody', 'thead', 'tfoot']);
  const emittedListItems = new Set<Element>();
  const walk = async (node: Node, inheritedStyle: ReaderContentStyle, inheritedContext: ParagraphContext | null): Promise<void> => {
    if (node.nodeType === 3 || node.nodeType === 4) {
      const text = node.textContent ?? '';
      if (!text || (!currentParts.length && /^[\t\r\n ]*$/.test(text) && !['pre', 'pre-wrap', 'break-spaces'].includes(inheritedStyle.whiteSpace ?? '') && inheritedContext?.blockType !== 'pre')) return;
      if (!currentParts.length) {
        currentContext = inheritedContext ?? { blockType: 'paragraph', style: inheritedStyle };
        if (pendingAnchorIds.length) {
          currentAnchorIds.push(...pendingAnchorIds);
          pendingAnchorIds = [];
        }
      }
      const style = styleDifference(inheritedStyle, currentContext.style);
      currentParts.push({ type: 'text', text, marks: [], ...(Object.keys(style).length ? { style } : {}) });
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = element.localName;
    const style = readerElementStyle(element, inheritedStyle, cssRules);
    if (paragraphTags.has(tag) || containerTags.has(tag) || /^h[1-6]$/.test(tag) || ['hr', 'img', 'image'].includes(tag)) flush();
    attachAnchor(element.getAttribute('id') || element.getAttribute('xml:id') || (tag === 'a' ? element.getAttribute('name') : null));
    if (style.display === 'none') return;
    if (tag === 'hr') {
      flush();
      readerBlocks.push({ type: 'rule', anchorIds: pendingAnchorIds, afterParagraphIndex: paragraphs.length, ...(Object.keys(style).length ? { style } : {}) });
      pendingAnchorIds = [];
      return;
    }
    if (paragraphTags.has(tag) || /^h[1-6]$/.test(tag)) {
      flush();
      const context: ParagraphContext = {
        blockType: tag === 'p' && inheritedContext?.blockType === 'list-item' ? 'list-item' : blockTypeFor(tag, inheritedContext),
        ...(blockLevel(tag) ? { level: blockLevel(tag)! } : {}),
        ...(tag === 'li' ? { listMarker: listMarker(element, style) } : inheritedContext?.blockType === 'list-item' ? { listMarker: inheritedContext.listMarker } : {}),
        style: tag === 'li' ? mergeReaderStyles(style, { marginInlineStart: `${1.5 * Array.from(element.ownerDocument.querySelectorAll('ul,ol')).filter((list) => list.contains(element)).length}em` }) : inheritedContext?.blockType === 'list-item' ? mergeReaderStyles(style, { marginInlineStart: inheritedContext.style.marginInlineStart ?? '1.5em' }) : style,
      };
      currentContext = context;
      currentAnchorIds.push(...pendingAnchorIds);
      pendingAnchorIds = [];
      const ownAnchor = element.getAttribute('id') || element.getAttribute('xml:id');
      if (ownAnchor) currentAnchorIds.push(epubAnchorId(path, ownAnchor));
      if (tag === 'li' && Array.from(element.children).some((nested) => paragraphTags.has(nested.localName) || containerTags.has(nested.localName))) {
        for (const nested of Array.from(element.childNodes)) {
          currentContext = { ...context, listMarker: emittedListItems.has(element) ? '' : context.listMarker };
          if (nested.nodeType === 1 && (paragraphTags.has((nested as Element).localName) || containerTags.has((nested as Element).localName))) {
            const nestedContext = currentContext;
            const beforeFlush = paragraphs.length;
            flush();
            if (paragraphs.length > beforeFlush) emittedListItems.add(element);
            const before = paragraphs.length;
            await walk(nested, style, { ...nestedContext, listMarker: emittedListItems.has(element) ? '' : nestedContext.listMarker });
            if (paragraphs.length > before) emittedListItems.add(element);
          } else {
            currentParts.push(...await walkInline(nested, style, style, [], undefined, undefined));
            if (nested.nextSibling?.nodeType === 1 && (paragraphTags.has((nested.nextSibling as Element).localName) || containerTags.has((nested.nextSibling as Element).localName))) {
              const before = paragraphs.length;
              flush();
              if (paragraphs.length > before) emittedListItems.add(element);
            }
          }
        }
      } else {
        for (const nested of Array.from(element.childNodes)) currentParts.push(...await walkInline(nested, style, style, [], undefined, undefined));
      }
      flush();
      return;
    }
    if (tag === 'img' || tag === 'image') {
      flush();
      const source = element.getAttribute('src')
        ?? element.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
        ?? element.getAttribute('href');
      if (!source) throw new Error(`EPUB image has no source: chapter=${index}`);
      const src = await epubImageDataUri(zip, path, source, mediaTypes);
      const alt = element.getAttribute('alt') ?? elements(element, 'title')[0]?.textContent ?? '';
      const imageStyle = mergeReaderStyles(parseStyleDeclarations('max-width:100%;height:auto'), style);
      readerBlocks.push({
        type: 'image', afterParagraphIndex: paragraphs.length, src, alt: normalize(alt), anchorIds: pendingAnchorIds,
        ...(element.getAttribute('title') ? { title: element.getAttribute('title')! } : {}),
        ...(Object.keys(imageStyle).length ? { style: imageStyle } : {}),
      });
      pendingAnchorIds = [];
      return;
    }
    if (tag === 'br') {
      if (!currentParts.length) currentContext = inheritedContext ?? { blockType: 'paragraph', style: inheritedStyle };
      currentParts.push({ type: 'break', marks: [], style });
      return;
    }
    if (containerTags.has(tag)) {
      flush();
      const context: ParagraphContext = {
        blockType: tag === 'blockquote' ? 'blockquote' : inheritedContext?.blockType ?? 'paragraph',
        ...(inheritedContext?.listMarker !== undefined ? { listMarker: inheritedContext.listMarker } : {}),
        style,
      };
      for (const child of Array.from(element.childNodes)) await walk(child, style, context);
      flush();
      return;
    }
    if (!currentParts.length) {
      currentContext = inheritedContext ?? { blockType: 'paragraph', style: inheritedStyle };
      currentAnchorIds.push(...pendingAnchorIds);
      pendingAnchorIds = [];
    }
    currentParts.push(...await walkInline(element, inheritedStyle, currentContext.style, [], undefined, undefined));
  };

  const bodyStyle = readerElementStyle(body, {}, cssRules);
  attachAnchor(body.getAttribute('id') || body.getAttribute('xml:id'));
  for (const child of Array.from(body.childNodes)) await walk(child, bodyStyle, null);
  flush();
  if (pendingAnchorIds.length && readerBlocks.length) readerBlocks.push({ type: 'spacer', afterParagraphIndex: paragraphs.length, anchorIds: pendingAnchorIds, style: { height: '0' } });
  return { paragraphs, readerBlocks, anchors };
}

interface TocEntry { title: string; path: string; fragment: string }
interface ContentFile extends ParsedChapterContent { path: string }

function tocEntry(base: string, href: string | null, title: string): TocEntry {
  if (!href || !normalize(title)) throw new Error('Invalid table of contents entry.');
  const url = new URL(href, new URL(base, 'https://epub.invalid/'));
  return { title: normalize(title), path: resolvePath(base, href), fragment: decodeURIComponent(url.hash.slice(1)) };
}

async function readTablesOfContents(opf: Document, opfPath: string, manifest: Map<string | null, Element>, read: (path: string) => Promise<string>): Promise<TocEntry[][]> {
  const tables: TocEntry[][] = [];
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
        tables.push(elements(map, 'navPoint').map((point) => {
          const direct = (name: string) => Array.from(point.children).find((node) => node.localName === name);
          return tocEntry(path, direct('content')?.getAttribute('src') ?? null, direct('navLabel')?.textContent ?? '');
        }));
      } else {
        const toc = elements(doc, 'nav').find((nav) =>
          (nav.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ?? nav.getAttribute('epub:type') ?? '').split(/\s+/).includes('toc'));
        if (toc) tables.push(elements(toc, 'a').map((link) => tocEntry(path, link.getAttribute('href'), link.textContent ?? '')));
      }
    } catch (error) {
      console.warn('epub-navigation-unreadable', { href: item.getAttribute('href'), cause: error instanceof Error ? error.message : String(error) });
      // Broken navigation must not prevent importing otherwise readable text.
    }
  }
  return tables;
}

function chapterFromBlocks(title: string, blocks: ReaderContentBlock[]): BookChapter {
  const paragraphs: string[] = [];
  const readerBlocks = blocks.map((block): ReaderContentBlock => {
    if (block.type !== 'paragraph') return { ...block, afterParagraphIndex: paragraphs.length };
    paragraphs.push(block.content.map((part) => part.type === 'text' ? part.text : '').join(''));
    return { ...block, paragraphIndex: paragraphs.length - 1 };
  });
  return { title, paragraphs, readerBlocks, titlePresentation: 'content' };
}

function groupChapters(files: ContentFile[], tables: TocEntry[][]): BookChapter[] {
  const blocks: ReaderContentBlock[] = [];
  const locations = new Map<string, { offset: number; file: ContentFile }>();
  for (const file of files) {
    // A link to a repeated spine document targets its first occurrence.
    if (!locations.has(file.path)) locations.set(file.path, { offset: blocks.length, file });
    blocks.push(...file.readerBlocks);
  }
  for (const table of tables) {
    const boundaries: Array<{ title: string; offset: number }> = [];
    let valid = table.length > 0;
    for (const entry of table) {
      const location = locations.get(entry.path);
      const local = entry.fragment ? location?.file.anchors.get(entry.fragment) : 0;
      if (!location || local === undefined) { valid = false; break; }
      const offset = location.offset + local;
      const previous = boundaries[boundaries.length - 1];
      if (previous && offset < previous.offset) { valid = false; break; }
      if (previous?.offset === offset) { previous.title = entry.title; continue; }
      boundaries.push({ title: entry.title, offset });
    }
    if (!valid || !boundaries.length) continue;
    if (boundaries[0].offset > 0) boundaries.unshift({ title: 'Front matter', offset: 0 });
    const chapters = boundaries.map((boundary, index) => chapterFromBlocks(
      boundary.title, blocks.slice(boundary.offset, boundaries[index + 1]?.offset ?? blocks.length),
    )).filter((chapter) => chapter.readerBlocks!.length > 0);
    if (chapters.length) return chapters;
  }
  return [chapterFromBlocks('Chapter 1', blocks)];
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
    const mediaTypes = new Map([...manifest.values()].flatMap((item) => {
      const href = item.getAttribute('href');
      const mediaType = item.getAttribute('media-type');
      return href && mediaType ? [[resolvePath(opfPath, href), mediaType] as const] : [];
    }));
    const spineRefs = elements(opf, 'itemref');
    if (!spineRefs.length) throw new Error('Could not read the EPUB chapter list.');
    const tables = await readTablesOfContents(opf, opfPath, manifest, read);
    const files: ContentFile[] = [];
    const supplementary: BookChapter[] = [];
    const supplementaryPaths = new Set<string>();
    for (const ref of spineRefs) {
      const item = manifest.get(ref.getAttribute('idref'));
      const href = item?.getAttribute('href');
      if (!item || !href) throw new Error('EPUB spine references a missing chapter.');
      const mediaType = item.getAttribute('media-type');
      if (mediaType !== 'application/xhtml+xml' && mediaType !== 'text/html') {
        throw new Error(`Unsupported EPUB chapter format: ${mediaType}`);
      }
      const path = resolvePath(opfPath, href);
      if (encryptedPaths.has(path)) throw new Error('DRM-protected EPUB chapters are not supported. Please import an unlocked copy.');
      const content = await chapterContent(await read(path), files.length + 1, mediaType, path, zip, mediaTypes);
      if (ref.getAttribute('linear') === 'no') {
        supplementaryPaths.add(path);
        const chapter = chapterFromBlocks('Supplementary content', content.readerBlocks);
        if (content.readerBlocks.length) supplementary.push({ ...chapter, linear: false });
      } else {
        files.push({ path, ...content });
      }
    }
    if (!files.some((file) => file.readerBlocks.length)) throw new Error('No readable text could be extracted from this EPUB. This does not necessarily mean the book is image-only or DRM-protected.');
    const chapters = [...groupChapters(files, tables.map((table) => table.filter((entry) => !supplementaryPaths.has(entry.path)))), ...supplementary];
    return { title, author, chapters };
  } catch (error) {
    throw new Error(`Could not import EPUB: ${error instanceof Error ? error.message : 'Invalid book.'}`);
  }
}
