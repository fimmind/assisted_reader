import { CALENDAR_EXCLUSIONS, SENTENCE_RE, TITLE_CASE_NOISE, WORD_RE, WORD_TOKEN_RE } from './constants';
import { isWordToken, normalizeToken, orderedUnique } from './math';
import type { DeinflectionResult, TaggedSentence, TaggedTerm } from './types';

type NlpLike = {
  (text: string): {
    terms: () => {
      json: () => Array<{ text?: string; normal?: string; tags?: string[]; terms?: Array<{ text?: string; normal?: string; tags?: string[] }> }>;
    };
    verbs: () => { toInfinitive: () => { out: (format: 'text') => string } };
    nouns: () => { toSingular: () => { out: (format: 'text') => string } };
    adjectives: () => { conjugate: () => Array<Record<string, string>> };
  };
};

function buildFallbackTerms(sentence: string): TaggedTerm[] {
  const terms: TaggedTerm[] = [];
  WORD_RE.lastIndex = 0;
  let match = WORD_RE.exec(sentence);
  let index = 0;
  while (match) {
    const raw = match[0];
    terms.push({
      raw,
      normalized: normalizeToken(raw),
      tags: new Set<string>(),
      sentenceInitial: index === 0,
    });
    index += 1;
    match = WORD_RE.exec(sentence);
  }
  WORD_RE.lastIndex = 0;
  return terms;
}

function flattenCompromiseTerms(jsonTerms: Array<{ text?: string; normal?: string; tags?: string[]; terms?: Array<{ text?: string; normal?: string; tags?: string[] }> }>): Array<{ text: string; tags: Set<string> }> {
  const output: Array<{ text: string; tags: Set<string> }> = [];
  for (const item of jsonTerms) {
    if (Array.isArray(item.terms) && item.terms.length > 0) {
      for (const nested of item.terms) {
        const text = nested.text ?? nested.normal ?? '';
        if (text.length === 0) {
          continue;
        }
        output.push({ text, tags: new Set<string>(nested.tags ?? []) });
      }
      continue;
    }

    const text = item.text ?? item.normal ?? '';
    if (text.length === 0) {
      continue;
    }
    output.push({ text, tags: new Set<string>(item.tags ?? []) });
  }
  return output;
}

function tagWithCompromise(sentence: string, nlp: NlpLike): TaggedTerm[] {
  const doc = nlp(sentence);
  const jsonTerms = doc.terms().json();
  const flattened = flattenCompromiseTerms(jsonTerms);
  const output: TaggedTerm[] = [];
  WORD_RE.lastIndex = 0;

  let tokenIndex = 0;
  for (const item of flattened) {
    let match = WORD_RE.exec(item.text);
    while (match) {
      const raw = match[0];
      output.push({
        raw,
        normalized: normalizeToken(raw),
        tags: item.tags,
        sentenceInitial: tokenIndex === 0,
      });
      tokenIndex += 1;
      match = WORD_RE.exec(item.text);
    }
    WORD_RE.lastIndex = 0;
  }

  return output;
}

export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  const matches = text.matchAll(SENTENCE_RE);
  for (const match of matches) {
    const chunk = match[0].trim();
    if (chunk.length > 0) {
      sentences.push(chunk);
    }
  }
  return sentences;
}

export function tagSentenceTerms(sentence: string, nlp: NlpLike | null): TaggedTerm[] {
  const fallback = buildFallbackTerms(sentence);
  if (!nlp) {
    return fallback;
  }

  try {
    const tagged = tagWithCompromise(sentence, nlp);
    if (tagged.length > 0) {
      return tagged;
    }
    return fallback;
  } catch (error) {
    console.warn('compromise-tagging-failed', { sentence, error });
    return fallback;
  }
}

export function buildTaggedSentences(text: string, nlp: NlpLike | null): TaggedSentence[] {
  const sentences = splitSentences(text);
  return sentences.map((sentence) => ({
    text: sentence,
    terms: tagSentenceTerms(sentence, nlp),
  }));
}

function isUppercaseInitial(raw: string): boolean {
  if (raw.length === 0) {
    return false;
  }
  const first = raw[0];
  return first === first.toUpperCase() && first !== first.toLowerCase();
}

function isAllUppercase(raw: string): boolean {
  return raw === raw.toUpperCase() && raw !== raw.toLowerCase();
}

function hasProperTag(term: TaggedTerm): boolean {
  const properTags = [
    'ProperNoun',
    'Person',
    'Place',
    'City',
    'Country',
    'Organization',
  ];
  return properTags.some((tag) => term.tags.has(tag));
}

export function isNameLikeToken(raw: string, sentenceInitial: boolean): boolean {
  if (!WORD_TOKEN_RE.test(raw)) {
    return false;
  }
  if (!isUppercaseInitial(raw)) {
    return false;
  }
  if (isAllUppercase(raw)) {
    return false;
  }

  const normalized = normalizeToken(raw);
  if (CALENDAR_EXCLUSIONS.has(normalized)) {
    return false;
  }
  if (TITLE_CASE_NOISE.has(normalized)) {
    return false;
  }
  if (sentenceInitial && raw.length <= 2) {
    return false;
  }

  return true;
}

export function isProperNounTag(term: TaggedTerm): boolean {
  if (hasProperTag(term)) {
    return true;
  }
  return isNameLikeToken(term.raw, term.sentenceInitial);
}

export function buildHighConfidenceProperNounLexicon(taggedSentences: TaggedSentence[]): Set<string> {
  type Accumulator = {
    total: number;
    proper: number;
    sentenceInitialProper: number;
    lowercaseSeen: number;
    nameLikeProper: number;
  };

  const stats = new Map<string, Accumulator>();

  for (const sentence of taggedSentences) {
    for (const term of sentence.terms) {
      if (!isWordToken(term.raw)) {
        continue;
      }
      const normalized = normalizeToken(term.raw);
      const existing = stats.get(normalized) ?? {
        total: 0,
        proper: 0,
        sentenceInitialProper: 0,
        lowercaseSeen: 0,
        nameLikeProper: 0,
      };

      existing.total += 1;

      const properTag = isProperNounTag(term);
      if (properTag) {
        existing.proper += 1;
        if (term.sentenceInitial) {
          existing.sentenceInitialProper += 1;
        }
        if (isNameLikeToken(term.raw, term.sentenceInitial)) {
          existing.nameLikeProper += 1;
        }
      }

      if (term.raw === term.raw.toLowerCase()) {
        existing.lowercaseSeen += 1;
      }

      stats.set(normalized, existing);
    }
  }

  const lexicon = new Set<string>();

  for (const [token, value] of stats.entries()) {
    if (CALENDAR_EXCLUSIONS.has(token)) {
      continue;
    }
    if (value.proper < 2) {
      continue;
    }
    if ((value.proper / value.total) < 0.6) {
      continue;
    }
    if (value.nameLikeProper < 2) {
      continue;
    }
    if (value.lowercaseSeen > 0) {
      continue;
    }
    if (value.sentenceInitialProper === value.proper && value.proper < 5) {
      continue;
    }
    lexicon.add(token);
  }

  return lexicon;
}

function mapTagsToWordClass(tags: Set<string>): { verb: boolean; noun: boolean; adjective: boolean } {
  return {
    verb: tags.has('Verb'),
    noun: tags.has('Noun'),
    adjective: tags.has('Adjective'),
  };
}

function extractConjugatedAdjective(doc: ReturnType<NlpLike>): string {
  const conjugation = doc.adjectives().conjugate();
  if (conjugation.length === 0) {
    return '';
  }
  const first = conjugation[0];
  const values = Object.values(first);
  if (values.length === 0) {
    return '';
  }
  return values[0] ?? '';
}

export function makeLemmaCandidates(term: TaggedTerm, lemmaDict: Record<string, string>, nlp: NlpLike | null): string[] {
  const normalized = normalizeToken(term.raw);
  const candidates: string[] = [];

  const lemmaFromDict = lemmaDict[normalized];
  if (lemmaFromDict) {
    candidates.push(normalizeToken(lemmaFromDict));
  }

  if (nlp) {
    try {
      const doc = nlp(term.raw);
      const classes = mapTagsToWordClass(term.tags);

      if (classes.verb) {
        candidates.push(normalizeToken(doc.verbs().toInfinitive().out('text')));
      }
      if (classes.noun) {
        candidates.push(normalizeToken(doc.nouns().toSingular().out('text')));
      }
      if (classes.adjective) {
        const adjective = extractConjugatedAdjective(doc);
        if (adjective.length > 0) {
          candidates.push(normalizeToken(adjective));
        }
      }

      candidates.push(normalizeToken(doc.verbs().toInfinitive().out('text')));
      candidates.push(normalizeToken(doc.nouns().toSingular().out('text')));
    } catch (error) {
      console.warn('compromise-lemmatization-failed', { raw: term.raw, error });
    }
  }

  candidates.push(normalized);

  const cleaned = candidates.filter((candidate) => candidate.length > 0 && WORD_TOKEN_RE.test(candidate));
  return orderedUnique(cleaned);
}

export function contextualDeinflectTaggedTerms(
  terms: TaggedTerm[],
  lemmaDict: Record<string, string>,
  lowerToIdx: Map<string, number>,
  properNounLexicon: Set<string>,
  excludeProperNouns: boolean,
  nlp: NlpLike | null,
): DeinflectionResult {
  const tokens: string[] = [];
  const properFlags: boolean[] = [];

  for (const term of terms) {
    const normalized = normalizeToken(term.raw);
    const tagProper = isProperNounTag(term);
    const properByLexicon = tagProper && properNounLexicon.has(normalized);
    properFlags.push(properByLexicon);

    if (excludeProperNouns && properByLexicon) {
      tokens.push('');
      continue;
    }

    const candidates = makeLemmaCandidates(term, lemmaDict, nlp);
    let chosen = normalized;

    for (const candidate of candidates) {
      if (lowerToIdx.has(candidate)) {
        chosen = candidate;
        break;
      }
    }

    if (chosen.length === 0 && candidates.length > 0) {
      chosen = candidates[0];
    }

    tokens.push(chosen);
  }

  return { tokens, properFlags };
}
