import { HYPHENATED_WORD_RE } from './constants';
import { normalizeToken } from './math';
import type { DefinitionTarget, LexiconEntry, PartOfSpeech } from './types';

export interface DefinitionLookupCandidate {
  lookupWord: string;
  selectionEnd: number;
  selectionStart: number;
  target: DefinitionTarget;
}

export interface DefinitionLookupSource {
  lookup: (word: string) => Promise<LexiconEntry | null>;
}

export interface ResolvedDefinitionLookup {
  candidate: DefinitionLookupCandidate;
  entry: LexiconEntry | null;
}

export function createDefinitionTarget(
  lemma: string,
  partOfSpeech: PartOfSpeech | null,
): DefinitionTarget {
  return {
    lemma: normalizeToken(lemma),
    partOfSpeech,
  };
}

export function definitionTargetKey(target: DefinitionTarget): string {
  return `${normalizeToken(target.lemma)}\u0000${target.partOfSpeech ?? ''}`;
}

export function areDefinitionTargetsEqual(left: DefinitionTarget, right: DefinitionTarget): boolean {
  return definitionTargetKey(left) === definitionTargetKey(right);
}

export function buildDefinitionLookupCandidates(
  contextText: string,
  componentStart: number,
  componentEnd: number,
  componentTarget: DefinitionTarget,
): DefinitionLookupCandidate[] {
  const componentWord = contextText.slice(componentStart, componentEnd);
  const candidates: DefinitionLookupCandidate[] = [];
  const matcher = new RegExp(HYPHENATED_WORD_RE.source, HYPHENATED_WORD_RE.flags);
  let match = matcher.exec(contextText);
  while (match) {
    const compoundStart = match.index;
    const compoundEnd = compoundStart + match[0].length;
    if (compoundStart <= componentStart && compoundEnd >= componentEnd) {
      const compoundWord = match[0];
      candidates.push({
        lookupWord: compoundWord,
        selectionEnd: compoundEnd,
        selectionStart: compoundStart,
        target: createDefinitionTarget(compoundWord, null),
      });
      break;
    }
    if (compoundStart > componentStart) {
      break;
    }
    match = matcher.exec(contextText);
  }
  candidates.push({
    lookupWord: componentWord,
    selectionEnd: componentEnd,
    selectionStart: componentStart,
    target: createDefinitionTarget(componentTarget.lemma, componentTarget.partOfSpeech),
  });
  return candidates;
}

async function lookupDefinitionCandidate(
  source: DefinitionLookupSource,
  candidate: DefinitionLookupCandidate,
): Promise<LexiconEntry | null> {
  const normalizedLookupWord = normalizeToken(candidate.lookupWord).trim();
  const normalizedLemma = normalizeToken(candidate.target.lemma).trim();
  if (normalizedLookupWord.length > 0 && normalizedLookupWord !== normalizedLemma) {
    const exactEntry = await source.lookup(normalizedLookupWord);
    if (exactEntry) {
      return exactEntry;
    }
  }
  if (normalizedLemma.length === 0) {
    return null;
  }
  return source.lookup(normalizedLemma);
}

export async function lookupFirstAvailableDefinition(
  source: DefinitionLookupSource,
  candidates: DefinitionLookupCandidate[],
): Promise<ResolvedDefinitionLookup> {
  if (candidates.length === 0) {
    throw new RangeError('Cannot look up a popup definition without candidates.');
  }
  for (const candidate of candidates) {
    const entry = await lookupDefinitionCandidate(source, candidate);
    if (entry) {
      return { candidate, entry };
    }
  }
  const fallbackCandidate = candidates[candidates.length - 1];
  if (!fallbackCandidate) {
    throw new RangeError('Cannot resolve a popup definition without a fallback candidate.');
  }
  return { candidate: fallbackCandidate, entry: null };
}
