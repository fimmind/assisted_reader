import { SENTENCE_RE } from './constants';
import type { LexiconEntry, LexiconSense, WsdMode } from './types';

export interface WsdContext {
  text: string;
  start: number;
  end: number;
}

interface SentenceSegment {
  text: string;
  paragraphIndex: number;
  start: number;
  end: number;
}

export const ETTIN_MARGIN_BY_REDUCTION_LEVEL: readonly number[] = [
  5.83791184425354,
  4.99607515335083,
  4.563767194747925,
  4.335683822631836,
  4.04623556137085,
  3.89186429977417,
  3.6085147857666016,
  3.5189156532287598,
  3.2664849758148193,
  3.125387668609619,
  2.8481526374816895,
];

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
    : mode === 'glite-lens' ? GLITE_LENS_MARGIN_BY_REDUCTION_LEVEL : ETTIN_MARGIN_BY_REDUCTION_LEVEL;
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

export function buildWsdPrompt(context: WsdContext, glosses: string[], letters: string[]): string {
  if (glosses.length < 2 || glosses.length > 127 || letters.length !== 128) {
    throw new RangeError(`Invalid WSD candidate count: candidates=${glosses.length} letters=${letters.length}`);
  }
  if (context.start < 0 || context.end <= context.start || context.end > context.text.length) {
    throw new RangeError(`Invalid WSD target span: start=${context.start} end=${context.end} length=${context.text.length}`);
  }
  const escaped = context.text.replaceAll('*', '∗');
  const marked = `${escaped.slice(0, context.start)}*${escaped.slice(context.start, context.end)}*${escaped.slice(context.end)}`;
  const options = glosses.map((gloss, index) => `${letters[index]}. ${gloss}`);
  options.push(`${letters[127]}. none of the above`);
  return `${marked}\n${options.join('\n')}\n[unused0] [MASK]`;
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
