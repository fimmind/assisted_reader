import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';

export interface TextLine {
  text: string;
  x: number;
  y: number;
  height: number;
  endX: number;
}

// Keep PDF content order. This deliberately does not attempt column detection.
export function pdfTextLines(items: TextContent['items']): TextLine[] {
  const lines: TextLine[] = [];
  let line: TextLine | undefined;
  const flush = () => {
    if (line?.text.trim()) lines.push(line);
    line = undefined;
  };

  for (const entry of items) {
    if (!('str' in entry)) continue;
    const item: TextItem = entry;
    const x = item.transform[4];
    const y = item.transform[5];
    const height = Math.max(Math.abs(item.height), 1);
    if (line && Math.abs(y - line.y) > Math.max(height, line.height) * 0.4) flush();
    if (!line) line = { text: '', x, y, height, endX: x };
    // Adjacent font runs may split a word. Only infer a space from a visible gap.
    const needsSpace = line.text && !/\s$/.test(line.text) && !/^\s/.test(item.str)
      && x - line.endX > height * 0.15;
    line.text += (needsSpace ? ' ' : '') + item.str;
    line.endX = x + item.width;
    line.height = Math.max(line.height, height);
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

function joinText(left: string, right: string): string {
  return /[\p{L}][\-\u00ad]$/u.test(left) && /^\p{Ll}/u.test(right)
    ? left.slice(0, -1) + right
    : left + (left ? ' ' : '') + right;
}

function lineParagraphs(lines: TextLine[]): string[] {
  const paragraphs: string[] = [];
  let paragraph = '';
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    const previous = lines[index - 1];
    const text = current.text.replace(/\s+/g, ' ').trim();
    // Preserve paragraph gaps and first-line indents, including after a hyphen.
    const newParagraph = previous && (
      Math.abs(previous.y - current.y) > Math.max(previous.height, current.height) * 1.8
      || current.x - previous.x > current.height * 0.8
    );
    if (newParagraph && paragraph) {
      paragraphs.push(paragraph);
      paragraph = '';
    }
    paragraph = joinText(paragraph, text);
  }
  if (paragraph) paragraphs.push(paragraph);
  return paragraphs.map((text) => text.replace(/\s+([,.;:!?\)\]\}])/g, '$1'));
}

export function pdfPageParagraphs(items: TextContent['items']): string[] {
  return lineParagraphs(pdfTextLines(items));
}

export interface PdfTextPage {
  lines: TextLine[];
  width: number;
  height: number;
  rotated?: boolean;
}

function marginKey(line: TextLine, page: PdfTextPage): string | null {
  const fraction = line.y / page.height;
  const zone = fraction >= 0.9 ? 'top' : fraction <= 0.1 ? 'bottom' : null;
  if (!zone || page.rotated) return null;
  const text = line.text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text || text.length > 120) return null;
  // A repeated chapter heading is still content, not a running header.
  if (/^(chapter|part|book)\s+(\d+|[ivxlcdm]+)\b/i.test(text)) return null;
  const number = /^(?:[-–—]\s*)?(?:page\s+)?(?:\d+|[ivxlcdm]+)(?:\s*(?:of|\/)\s*\d+)?(?:\s*[-–—])?$/i.test(text);
  return `${zone}:${number ? '#page' : text.replace(/\d+/g, '#')}`;
}

function marginCandidates(page: PdfTextPage): Map<TextLine, string> {
  const result = new Map<TextLine, string>();
  // Only inspect the outer two lines on each side, with a visible gap from prose.
  const ordered = [...page.lines].sort((a, b) => b.y - a.y);
  for (const edge of [ordered, [...ordered].reverse()]) {
    for (let count = 1; count <= Math.min(2, edge.length - 1); count += 1) {
      const candidates = edge.slice(0, count);
      if (!candidates.every((line) => marginKey(line, page))) break;
      const inner = edge[count];
      const adjacent = edge[count - 1];
      if (Math.abs(inner.y - adjacent.y) <= Math.max(inner.height, adjacent.height) * 1.8) continue;
      for (const line of candidates) result.set(line, marginKey(line, page)!);
    }
  }
  return result;
}

function continuesParagraph(previous: PdfTextPage, next: PdfTextPage, left: string, right: string): boolean {
  if (previous.rotated || next.rotated || !previous.lines.length || !next.lines.length) return false;
  const last = previous.lines[previous.lines.length - 1];
  const first = next.lines[0];
  // Lowercase continuation avoids joining chapter headings or new sentences.
  if (!/^\p{Ll}/u.test(right) || /[.!?:;…]["'”’\)\]]*$/u.test(left)) return false;
  if (last.y > previous.height * 0.2 || first.y < next.height * 0.75) return false;
  if (Math.abs(last.height - first.height) > Math.max(last.height, first.height) * 0.15) return false;
  const leftMargin = Math.min(...next.lines.map((line) => line.x));
  if (first.x - leftMargin > first.height * 0.8) return false;
  const previousMargin = Math.min(...previous.lines.map((line) => line.x));
  return Math.abs(first.x / next.width - previousMargin / previous.width) * next.width <= first.height * 0.8;
}

export function pdfDocumentParagraphs(pages: PdfTextPage[]): string[] {
  const candidates = pages.map(marginCandidates);
  const counts = new Map<string, number>();
  for (const page of candidates) {
    for (const key of new Set(page.values())) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // Supports alternating running headers, but never deletes one-off margin text.
  const threshold = Math.max(2, Math.ceil(pages.filter((page) => page.lines.length).length * 0.4));
  const paragraphs: string[] = [];
  let previous: PdfTextPage | undefined;
  pages.forEach((page, index) => {
    const cleaned = { ...page, lines: page.lines.filter((line) => {
      const key = candidates[index].get(line);
      return !key || (counts.get(key) ?? 0) < threshold;
    }) };
    const current = lineParagraphs(cleaned.lines);
    if (previous && current.length && paragraphs.length
      && continuesParagraph(previous, cleaned, paragraphs[paragraphs.length - 1], current[0])) {
      paragraphs[paragraphs.length - 1] = joinText(paragraphs[paragraphs.length - 1], current.shift()!);
    }
    paragraphs.push(...current);
    // An empty page intentionally interrupts continuation detection.
    previous = cleaned;
  });
  return paragraphs;
}
