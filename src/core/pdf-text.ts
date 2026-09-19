import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';

interface TextLine {
  text: string;
  x: number;
  y: number;
  height: number;
  endX: number;
}

// Keep PDF content order. This deliberately does not attempt column detection.
export function pdfPageParagraphs(items: TextContent['items']): string[] {
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
    if (/[\p{L}][\-\u00ad]$/u.test(paragraph) && /^\p{Ll}/u.test(text)) {
      paragraph = paragraph.slice(0, -1) + text;
    } else {
      paragraph += (paragraph ? ' ' : '') + text;
    }
  }
  if (paragraph) paragraphs.push(paragraph);
  return paragraphs.map((text) => text.replace(/\s+([,.;:!?\)\]\}])/g, '$1'));
}
