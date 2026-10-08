import type { ReaderContentStyle, ReaderInlineContent, ReaderInlineMark, ReaderTextRun } from './types';

export interface RawTextPart {
  type: 'text';
  text: string;
  marks: ReaderInlineMark[];
  style?: ReaderContentStyle;
  href?: string;
  title?: string;
}

export interface RawImagePart {
  type: 'image';
  src: string;
  alt: string;
  title?: string;
  style?: ReaderContentStyle;
}

export interface RawBreakPart {
  type: 'break';
  marks: ReaderInlineMark[];
  style?: ReaderContentStyle;
}

export type RawInlinePart = RawTextPart | RawImagePart | RawBreakPart;

/** Preserve explicit breaks and nonbreaking spaces while keeping the NLP projection identical to rendered text. */
export function normalizeInlineParts(parts: RawInlinePart[], preserveWhitespace: boolean): { text: string; content: ReaderInlineContent[] } {
  const content: ReaderInlineContent[] = [];
  let pendingSpace = false;
  let hasText = false;
  let afterBreak = false;
  for (const part of parts) {
    if (part.type === 'image') {
      if (pendingSpace) content.push({ type: 'text', text: ' ', marks: [] });
      pendingSpace = false;
      content.push({ ...part });
      continue;
    }
    if (part.type === 'break') {
      content.push({ type: 'text', text: '\n', marks: [...part.marks], style: { ...part.style, whiteSpace: 'pre-wrap' } });
      pendingSpace = false;
      hasText = true;
      afterBreak = true;
      continue;
    }
    const text = preserveWhitespace ? part.text : part.text.replace(/[\t\r\n ]+/g, ' ');
    const trimmed = preserveWhitespace ? text : text.replace(/^ +| +$/g, '');
    if (!trimmed) {
      if (!preserveWhitespace && text) pendingSpace = hasText && !afterBreak;
      continue;
    }
    const prefix = !preserveWhitespace && hasText && !afterBreak && (pendingSpace || text.startsWith(' ')) ? ' ' : '';
    content.push({ ...part, text: prefix + trimmed, marks: [...part.marks] });
    hasText = true;
    afterBreak = trimmed.endsWith('\n');
    pendingSpace = !preserveWhitespace && text.endsWith(' ');
  }
  return { text: content.map((item) => item.type === 'text' ? item.text : '').join(''), content };
}

const STYLE_PROPERTIES: Record<string, keyof ReaderContentStyle> = {
  'background-color': 'backgroundColor',
  'border-bottom': 'borderBottom',
  'border-color': 'borderColor',
  'border-style': 'borderStyle',
  'border-top': 'borderTop',
  'border-width': 'borderWidth',
  'direction': 'direction',
  'display': 'display',
  'font-size': 'fontSize',
  'font-style': 'fontStyle',
  'font-weight': 'fontWeight',
  'height': 'height',
  'letter-spacing': 'letterSpacing',
  'list-style-type': 'listStyleType',
  'margin-bottom': 'marginBottom',
  'margin-left': 'marginLeft',
  'margin-right': 'marginRight',
  'margin': 'margin',
  'margin-inline-end': 'marginInlineEnd',
  'margin-inline-start': 'marginInlineStart',
  'margin-top': 'marginTop',
  'max-height': 'maxHeight',
  'max-width': 'maxWidth',
  'min-width': 'minWidth',
  'object-fit': 'objectFit',
  'object-position': 'objectPosition',
  'padding-bottom': 'paddingBottom',
  'padding-left': 'paddingLeft',
  'padding-right': 'paddingRight',
  'padding': 'padding',
  'padding-inline-end': 'paddingInlineEnd',
  'padding-inline-start': 'paddingInlineStart',
  'padding-top': 'paddingTop',
  'text-align': 'textAlign',
  'text-decoration': 'textDecoration',
  'text-indent': 'textIndent',
  'text-transform': 'textTransform',
  'vertical-align': 'verticalAlign',
  'white-space': 'whiteSpace',
  'width': 'width',
  'word-spacing': 'wordSpacing',
  'float': 'float',
  'clear': 'clear',
  'color': 'color',
};

function scalableFontSize(value: string): string {
  const match = value.match(/^([0-9]*\.?[0-9]+)(px|pt|pc|in|cm|mm|q)$/i);
  if (!match) return value;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const pixels = unit === 'px' ? amount
    : unit === 'pt' ? amount * (96 / 72)
      : unit === 'pc' ? amount * 16
        : unit === 'in' ? amount * 96
          : unit === 'cm' ? amount * (96 / 2.54)
            : unit === 'mm' ? amount * (96 / 25.4)
              : amount * (96 / 101.6);
  return `${pixels / 16}em`;
}

export function parseStyleDeclarations(value: string): ReaderContentStyle {
  const style: ReaderContentStyle = {};
  for (const declaration of value.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const cssValue = declaration.slice(separator + 1).replace(/\s*!important\s*$/i, '').trim();
    const readerProperty = STYLE_PROPERTIES[property];
    if (!readerProperty || cssValue.length === 0 || cssValue.length > 160) continue;
    if (/url\s*\(|expression\s*\(|javascript\s*:|var\s*\(/i.test(cssValue)) continue;
    style[readerProperty] = readerProperty === 'fontSize' ? scalableFontSize(cssValue) : cssValue;
  }
  return style;
}

export function mergeReaderStyles(...styles: Array<ReaderContentStyle | undefined>): ReaderContentStyle {
  const merged: ReaderContentStyle = {};
  for (const style of styles) {
    if (!style) continue;
    Object.assign(merged, style);
  }
  return merged;
}

export function inheritedReaderStyle(style: ReaderContentStyle): ReaderContentStyle {
  const inherited: ReaderContentStyle = {};
  for (const property of [
    'color', 'direction', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'letterSpacing',
    'lineHeight', 'listStyleType', 'textAlign', 'textTransform', 'whiteSpace', 'wordSpacing',
  ] as const) {
    const value = style[property];
    if (value !== undefined) inherited[property] = value;
  }
  return inherited;
}
