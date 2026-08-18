import { normalizeToken } from './math';
import type { DefinitionTarget, PartOfSpeech } from './types';

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
