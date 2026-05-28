import { WORD_TOKEN_RE } from './constants';

export function clip01(value: number): number {
  const min = 1e-6;
  const max = 1 - 1e-6;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function logit(probability: number): number {
  const clipped = clip01(probability);
  return Math.log(clipped / (1 - clipped));
}

export function sigmoid(value: number): number {
  if (value >= 0) {
    const expNeg = Math.exp(-value);
    return 1 / (1 + expNeg);
  }
  const expPos = Math.exp(value);
  return expPos / (1 + expPos);
}

export function normalizeApostrophes(value: string): string {
  return value.replace(/’/g, "'");
}

export function normalizeToken(value: string): string {
  return normalizeApostrophes(value.toLowerCase());
}

export function orderedUnique(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      output.push(value);
    }
  }
  return output;
}

export function isWordToken(value: string): boolean {
  return WORD_TOKEN_RE.test(value);
}

export function createId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}-${time}-${random}`;
}

export function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return 0;
  }
  return parsed;
}
