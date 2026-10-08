import type { ReaderContentStyle } from './types';
import { inheritedReaderStyle, mergeReaderStyles, parseStyleDeclarations } from './rich-content';

interface ReaderCssDeclaration {
  property: string;
  value: string;
  important: boolean;
}

export interface ReaderCssRule {
  selector: string;
  specificity: number;
  order: number;
  declarations: ReaderCssDeclaration[];
}

function cssSpecificity(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+(?:\([^)]*\))?/g) ?? []).length;
  const tags = (selector.match(/(^|[\s>+~])(?:[a-zA-Z][\w-]*|\*)/g) ?? []).length;
  return ids * 10000 + classes * 100 + tags;
}

function parseCssDeclarations(css: string): ReaderCssDeclaration[] {
  return css.split(';').flatMap((declaration) => {
    const separator = declaration.indexOf(':');
    if (separator < 0) return [];
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const rawValue = declaration.slice(separator + 1).trim();
    const important = /\s*!important\s*$/i.test(rawValue);
    const value = rawValue.replace(/\s*!important\s*$/i, '').trim();
    return property && value ? [{ property, value, important }] : [];
  });
}

export function readerMediaMatches(query: string): boolean {
  if (!query.trim()) return true;
  if (typeof matchMedia === 'function') return matchMedia(query).matches;
  return query.toLowerCase().split(',').some((part) => !/\bprint\b|\bspeech\b/.test(part) && !/^\s*not\s+(screen|all)\b/.test(part));
}

function findClosingBrace(css: string, openingIndex: number): number {
  let depth = 1;
  let quote = '';
  for (let index = openingIndex + 1; index < css.length; index += 1) {
    const character = css[index];
    if (quote) {
      if (character === quote && css[index - 1] !== '\\') quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function readerCssRules(cssInput: string): ReaderCssRule[] {
  const css = cssInput.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@(?:charset|import)\s+[^;]+;/gi, '');
  const rules: ReaderCssRule[] = [];
  let order = 0;
  const readRules = (source: string) => {
    let cursor = 0;
    while (cursor < source.length) {
      const openingIndex = source.indexOf('{', cursor);
      if (openingIndex < 0) break;
      const closingIndex = findClosingBrace(source, openingIndex);
      if (closingIndex < 0) break;
      const header = source.slice(cursor, openingIndex).trim();
      const body = source.slice(openingIndex + 1, closingIndex);
      if (/^@media\b/i.test(header) && readerMediaMatches(header.replace(/^@media\s*/i, ''))) {
        readRules(body);
      } else if (!header.startsWith('@')) {
        const declarations = parseCssDeclarations(body);
        for (const selector of header.split(',')) {
          const trimmed = selector.trim();
          if (trimmed) rules.push({ selector: trimmed, specificity: cssSpecificity(trimmed), order, declarations });
        }
        order += 1;
      }
      cursor = closingIndex + 1;
    }
  };
  readRules(css);
  return rules;
}

function declarationStyle(declarations: ReaderCssDeclaration[]): ReaderContentStyle {
  const winning = new Map<string, ReaderCssDeclaration>();
  for (const declaration of declarations) {
    const candidate = winning.get(declaration.property);
    if (!candidate || declaration.important || !candidate.important) {
      winning.set(declaration.property, declaration);
    }
  }
  return parseStyleDeclarations([...winning.values()].map(({ property, value }) => `${property}:${value}`).join(';'));
}

export function readerElementStyle(
  element: Element,
  inherited: ReaderContentStyle,
  rules: ReaderCssRule[],
): ReaderContentStyle {
  const winners = new Map<string, { value: string; important: boolean; specificity: number; order: number }>();
  for (const rule of rules) {
    let matches = false;
    try {
      matches = element.matches(rule.selector);
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'SyntaxError') throw error;
    }
    if (!matches) continue;
    for (const declaration of rule.declarations) {
      const current = winners.get(declaration.property);
      const wins = !current
        || (declaration.important && !current.important)
        || (declaration.important === current.important
          && (rule.specificity > current.specificity
            || (rule.specificity === current.specificity && rule.order >= current.order)));
      if (wins) winners.set(declaration.property, {
        value: declaration.value,
        important: declaration.important,
        specificity: rule.specificity,
        order: rule.order,
      });
    }
  }
  for (const declaration of parseCssDeclarations(element.getAttribute('style') ?? '')) {
    const current = winners.get(declaration.property);
    const wins = !current
      || (declaration.important && !current.important)
      || (declaration.important === current.important && current.specificity <= 1000000);
    if (wins) winners.set(declaration.property, {
        value: declaration.value,
        important: declaration.important,
        specificity: 1000000,
        order: Number.MAX_SAFE_INTEGER,
    });
  }
  const ownStyle = declarationStyle([...winners].map(([property, winner]) => ({
    property,
    value: winner.value,
    important: winner.important,
  })));
  const align = element.getAttribute('align');
  const alignStyle = align ? parseStyleDeclarations(`text-align:${align}`) : undefined;
  const presentationStyle = element.localName === 'img'
    ? parseStyleDeclarations([
      element.getAttribute('width') ? `width:${element.getAttribute('width')}` : '',
      element.getAttribute('height') ? `height:${element.getAttribute('height')}` : '',
    ].filter(Boolean).join(';'))
    : undefined;
  return mergeReaderStyles(inheritedReaderStyle(inherited), presentationStyle, alignStyle, ownStyle);
}

