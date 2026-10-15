import { SENTENCE_RE } from './constants';
import type { LexiconEntry, LexiconSense, WsdMode } from './types';

export interface WsdContext {
  text: string;
  start: number;
  end: number;
  /** Ancestor definitions from nearest to furthest, followed by the original passage. */
  outerContexts?: readonly string[];
}

/** Fit nested lookups using the model tokenizer, adding whole ancestors until one exceeds the budget. */
export function fitNestedWsdContext(context: WsdContext, fits: (candidate: WsdContext) => boolean): WsdContext {
  if (context.outerContexts === undefined) {
    return context;
  }
  validateContextSource([context.text], 0, context);
  let selected: WsdContext = { text: context.text, start: context.start, end: context.end };
  if (!fits(selected)) {
    const target = context.text.slice(context.start, context.end);
    selected = { text: target, start: 0, end: target.length };
    if (!fits(selected)) {
      throw new RangeError(`WSD target exceeds model context: target=${target}`);
    }
    let low = 0;
    let high = Math.max(context.start, context.text.length - context.end);
    while (low < high) {
      const radius = Math.ceil((low + high) / 2);
      const start = Math.max(0, context.start - radius);
      const end = Math.min(context.text.length, context.end + radius);
      const candidate = { text: context.text.slice(start, end), start: context.start - start, end: context.end - start };
      if (fits(candidate)) {
        selected = candidate;
        low = radius;
      } else {
        high = radius - 1;
      }
    }
  }
  for (const outer of context.outerContexts) {
    const prefix = `${outer}\n\n`;
    const candidate = { text: prefix + selected.text, start: prefix.length + selected.start, end: prefix.length + selected.end };
    if (!fits(candidate)) {
      break;
    }
    selected = candidate;
  }
  return selected;
}

interface SentenceSegment {
  text: string;
  paragraphIndex: number;
  start: number;
  end: number;
}

export const SAYEDSHAUN_MARGIN_BY_REDUCTION_LEVEL: readonly number[] = [
  8.013749546077884,
  7.150079341920595,
  5.1866249366168375,
  3.922373754862072,
  3.5443301865161416,
  3.3042476867311947,
  3.0947652411336293,
  2.8522067646180744,
  2.584678309612947,
  2.4042438881280717,
  2.341348441519557,
];

export const GLITE_LENS_MARGIN_BY_REDUCTION_LEVEL: readonly number[] = [
  35.92956075091025,
  28.801170284738646,
  23.68325989190771,
  18.85929058255408,
  15.516171207015532,
  14.074248390984962,
  13.36846521612813,
  12.813326430410257,
  11.132158141324226,
  9.989735323122886,
  9.027904800054216,
];

export function marginForReductionLevel(level: number, mode: WsdMode): number {
  if (mode === 'none') {
    throw new RangeError(`WSD reduction margin requires an enabled model: mode=${mode}`);
  }
  const margins = mode === 'sayedshaun' ? SAYEDSHAUN_MARGIN_BY_REDUCTION_LEVEL
    : GLITE_LENS_MARGIN_BY_REDUCTION_LEVEL;
  const margin = margins[level];
  if (!Number.isInteger(level) || margin === undefined) {
    throw new RangeError(`Invalid WSD reduction level: level=${level}`);
  }
  return margin;
}

function validateContextSource(paragraphs: readonly string[], paragraphIndex: number, context: WsdContext): void {
  if (!Number.isInteger(paragraphIndex) || paragraphs[paragraphIndex] !== context.text) {
    throw new RangeError(`Invalid WSD source paragraph: index=${paragraphIndex} paragraphs=${paragraphs.length}`);
  }
  if (context.start < 0 || context.end <= context.start || context.end > context.text.length) {
    throw new RangeError(`Invalid WSD target span: start=${context.start} end=${context.end} length=${context.text.length}`);
  }
}

function windowBounds(total: number, targetIndex: number, requestedCount: number): { start: number; end: number } {
  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 3) {
    throw new RangeError(`Invalid WSD context size: size=${requestedCount}`);
  }
  const count = Math.min(total, requestedCount);
  const start = Math.min(Math.max(0, targetIndex - Math.floor((count - 1) / 2)), total - count);
  return { start, end: start + count };
}

export function paragraphWindowForWsd(
  paragraphs: readonly string[],
  paragraphIndex: number,
  context: WsdContext,
  count: number,
): WsdContext {
  validateContextSource(paragraphs, paragraphIndex, context);
  const bounds = windowBounds(paragraphs.length, paragraphIndex, count);
  const before = paragraphs.slice(bounds.start, paragraphIndex).join('\n\n');
  const prefixLength = before.length + (bounds.start < paragraphIndex ? 2 : 0);
  return {
    text: paragraphs.slice(bounds.start, bounds.end).join('\n\n'),
    start: prefixLength + context.start,
    end: prefixLength + context.end,
  };
}

export function sentenceWindowForWsd(
  paragraphs: readonly string[],
  paragraphIndex: number,
  context: WsdContext,
  count: number,
): WsdContext {
  validateContextSource(paragraphs, paragraphIndex, context);
  const segments: SentenceSegment[] = [];
  for (let index = Math.max(0, paragraphIndex - 2); index < Math.min(paragraphs.length, paragraphIndex + 3); index += 1) {
    const matcher = new RegExp(SENTENCE_RE.source, SENTENCE_RE.flags);
    for (const match of paragraphs[index].matchAll(matcher)) {
      const text = match[0].trim();
      if (text.length === 0) {
        continue;
      }
      const leadingWhitespace = match[0].length - match[0].trimStart().length;
      const start = match.index + leadingWhitespace;
      segments.push({ text, paragraphIndex: index, start, end: start + text.length });
    }
  }
  const targetIndex = segments.findIndex((segment) =>
    segment.paragraphIndex === paragraphIndex && segment.start <= context.start && context.end <= segment.end);
  if (targetIndex < 0) {
    throw new RangeError(`WSD target is outside sentence spans: paragraph=${paragraphIndex} start=${context.start} end=${context.end}`);
  }
  const bounds = windowBounds(segments.length, targetIndex, count);
  const selected = segments.slice(bounds.start, bounds.end);
  const before = selected.slice(0, targetIndex - bounds.start).map((segment) => segment.text).join(' ');
  const prefixLength = before.length + (before.length > 0 ? 1 : 0);
  const target = segments[targetIndex];
  return {
    text: selected.map((segment) => segment.text).join(' '),
    start: prefixLength + context.start - target.start,
    end: prefixLength + context.end - target.start,
  };
}

export function wordNetGlosses(entry: LexiconEntry): string[] {
  return entry.senses.flatMap((sense) => sense.source === 'wordnet' ? sense.definitions : []);
}

export function wordNetDefinitionIds(entry: LexiconEntry): string[] {
  return entry.senses.flatMap((sense) => {
    if (sense.source !== 'wordnet') {
      return [];
    }
    if (!sense.definitionIds || sense.definitionIds.length !== sense.definitions.length) {
      throw new Error(`WordNet sense IDs are missing: word=${entry.word} partOfSpeech=${sense.partOfSpeech}`);
    }
    return sense.definitionIds;
  });
}

export function filterWordNetEntry(entry: LexiconEntry, scores: number[], margin: number): LexiconEntry {
  const glosses = wordNetGlosses(entry);
  if (scores.length !== glosses.length || scores.some((score) => !Number.isFinite(score))) {
    throw new RangeError(`Invalid WSD scores: scores=${scores.length} definitions=${glosses.length}`);
  }
  if (!Number.isFinite(margin) || margin < 0) {
    throw new RangeError(`Invalid WSD margin: margin=${margin}`);
  }
  const best = Math.max(...scores);
  let offset = 0;
  const senses: LexiconSense[] = entry.senses.flatMap((sense) => {
    if (sense.source !== 'wordnet') {
      return [sense];
    }
    const scored = sense.definitions.map((gloss, index) => ({
      gloss,
      id: sense.definitionIds?.[index],
      score: scores[offset + index],
      index,
    }));
    offset += sense.definitions.length;
    const retained = scored
      .filter((item) => best - item.score <= margin)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    return retained.length > 0 ? [{ ...sense,
      definitions: retained.map((item) => item.gloss),
      definitionIds: sense.definitionIds ? retained.map((item) => item.id as string) : undefined,
    }] : [];
  });
  if (senses.length === 0) {
    throw new Error(`WSD excluded every definition: word=${entry.word} margin=${margin}`);
  }
  return { ...entry, senses };
}
