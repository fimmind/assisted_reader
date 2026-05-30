import { CALENDAR_EXCLUSIONS, SENTENCE_RE, TITLE_CASE_NOISE, WORD_RE, WORD_TOKEN_RE } from './constants';
import { isWordToken, normalizeToken, orderedUnique } from './math';
import type { DeinflectionResult, TaggedSentence, TaggedTerm } from './types';

type CompromiseTags = string[] | Record<string, unknown>;
type CompromiseTermNode = {
  text?: string;
  normal?: string;
  tags?: CompromiseTags;
  terms?: CompromiseTermNode[];
};

type NlpLike = {
  (text: string): {
    terms: () => {
      json: () => CompromiseTermNode[];
    };
    verbs: () => { toInfinitive: () => { out: (format: 'text') => string } };
    nouns: () => { toSingular: () => { out: (format: 'text') => string } };
    adjectives: () => { conjugate: () => Array<Record<string, string>> };
  };
};

const COMPROMISE_PROPER_TAGS = new Set<string>([
  'ProperNoun',
  'Person',
  'FirstName',
  'LastName',
  'MaleName',
  'FemaleName',
  'Place',
  'City',
  'Country',
  'Region',
  'Organization',
  'Demonym',
  'Acronym',
  'Nationality',
]);

const NEGATIVE_CONTRACTION_STEM_OVERRIDES: Record<string, string> = {
  ca: 'can',
  wo: 'will',
  sha: 'shall',
};

const NEGATIVE_CONTRACTION_LEMMA_OVERRIDES: Record<string, string> = {
  am: 'be',
  are: 'be',
  did: 'do',
  does: 'do',
  had: 'have',
  has: 'have',
  is: 'be',
  was: 'be',
  were: 'be',
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

function extractCompromiseTermTags(rawTags: CompromiseTags | undefined): Set<string> {
  const normalizeTag = (tag: string) => tag.replace(/^#/, '').trim();

  if (Array.isArray(rawTags)) {
    return new Set<string>(rawTags.map((tag) => normalizeTag(String(tag))).filter((tag) => tag.length > 0));
  }
  if (rawTags && typeof rawTags === 'object') {
    return new Set<string>(Object.keys(rawTags).map((tag) => normalizeTag(tag)).filter((tag) => tag.length > 0));
  }
  return new Set<string>();
}

function flattenCompromiseTerms(jsonTerms: CompromiseTermNode[]): Array<{ text: string; tags: Set<string> }> {
  const output: Array<{ text: string; tags: Set<string> }> = [];
  for (const item of jsonTerms) {
    const parentTags = extractCompromiseTermTags(item.tags);
    if (Array.isArray(item.terms) && item.terms.length > 0) {
      for (const nested of item.terms) {
        const text = nested.text ?? nested.normal ?? '';
        if (text.length === 0) {
          continue;
        }
        const mergedTags = new Set<string>(parentTags);
        for (const tag of extractCompromiseTermTags(nested.tags)) {
          mergedTags.add(tag);
        }
        output.push({ text, tags: mergedTags });
      }
      continue;
    }

    const text = item.text ?? item.normal ?? '';
    if (text.length === 0) {
      continue;
    }
    output.push({ text, tags: parentTags });
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
  SENTENCE_RE.lastIndex = 0;
  const sentences: string[] = [];
  const matches = text.matchAll(SENTENCE_RE);
  for (const match of matches) {
    const chunk = match[0].trim();
    if (chunk.length > 0) {
      sentences.push(chunk);
    }
  }
  SENTENCE_RE.lastIndex = 0;
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

function isTitleCaseToken(raw: string): boolean {
  return isUppercaseInitial(raw) && !isAllUppercase(raw);
}

function hasProperTag(term: TaggedTerm): boolean {
  for (const tag of COMPROMISE_PROPER_TAGS) {
    if (term.tags.has(tag)) {
      return true;
    }
  }
  return false;
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
  if (isAllUppercase(term.raw)) {
    if (term.raw.length < 2) {
      return false;
    }
    const normalized = normalizeToken(term.raw);
    if (CALENDAR_EXCLUSIONS.has(normalized) || TITLE_CASE_NOISE.has(normalized)) {
      return false;
    }
    return true;
  }
  return isNameLikeToken(term.raw, term.sentenceInitial);
}

function isStrongProperShapeTerm(term: TaggedTerm, next: TaggedTerm | null): boolean {
  if (!WORD_TOKEN_RE.test(term.raw)) {
    return false;
  }

  const normalized = normalizeToken(term.raw);
  if (CALENDAR_EXCLUSIONS.has(normalized) || TITLE_CASE_NOISE.has(normalized)) {
    return false;
  }

  if (isAllUppercase(term.raw)) {
    return term.raw.length >= 2;
  }

  if (!isTitleCaseToken(term.raw)) {
    return false;
  }

  if (term.sentenceInitial && next !== null) {
    const nextIsTitleCaseWord = WORD_TOKEN_RE.test(next.raw) && isTitleCaseToken(next.raw);
    if (nextIsTitleCaseWord && !normalized.endsWith('ly')) {
      return true;
    }
  }

  return !term.sentenceInitial;
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

function buildApostropheLemmaCandidates(normalizedToken: string): string[] {
  if (!normalizedToken.includes('\'')) {
    return [];
  }

  const candidates: string[] = [];
  const addCandidate = (value: string): void => {
    const normalized = normalizeToken(value);
    if (normalized.length === 0 || !WORD_TOKEN_RE.test(normalized)) {
      return;
    }
    candidates.push(normalized);
  };

  if (normalizedToken.endsWith("'s")) {
    addCandidate(normalizedToken.slice(0, -2));
  }
  if (normalizedToken.endsWith("s'")) {
    addCandidate(normalizedToken.slice(0, -1));
  }

  const detachableSuffixes = ["'re", "'ve", "'ll", "'d", "'m"];
  for (const suffix of detachableSuffixes) {
    if (normalizedToken.endsWith(suffix) && normalizedToken.length > suffix.length) {
      addCandidate(normalizedToken.slice(0, -suffix.length));
    }
  }

  if (normalizedToken.endsWith("n't") && normalizedToken.length > 3) {
    const contractionStem = normalizeToken(normalizedToken.slice(0, -3));
    addCandidate(contractionStem);

    const expandedStem = NEGATIVE_CONTRACTION_STEM_OVERRIDES[contractionStem] ?? contractionStem;
    addCandidate(expandedStem);

    const normalizedLemma = NEGATIVE_CONTRACTION_LEMMA_OVERRIDES[expandedStem]
      ?? NEGATIVE_CONTRACTION_LEMMA_OVERRIDES[contractionStem];
    if (typeof normalizedLemma === 'string' && normalizedLemma.length > 0) {
      addCandidate(normalizedLemma);
    }
  }

  return orderedUnique(candidates);
}

function buildLemmaCandidateCacheKey(
  term: TaggedTerm,
  classes: { verb: boolean; noun: boolean; adjective: boolean },
  lemmaFromDict: string | undefined,
  hasNlp: boolean,
): string {
  const normalizedLemmaFromDict = typeof lemmaFromDict === 'string' && lemmaFromDict.length > 0
    ? normalizeToken(lemmaFromDict)
    : '';
  return `${term.raw}\n${classes.verb ? '1' : '0'}${classes.noun ? '1' : '0'}${classes.adjective ? '1' : '0'}\n${hasNlp ? '1' : '0'}\n${normalizedLemmaFromDict}`;
}

export function makeLemmaCandidates(
  term: TaggedTerm,
  lemmaDict: Record<string, string>,
  nlp: NlpLike | null,
  cache?: Map<string, string[]>,
): string[] {
  const normalized = normalizeToken(term.raw);
  const classes = mapTagsToWordClass(term.tags);
  const hasOwnLemma = Object.prototype.hasOwnProperty.call(lemmaDict, normalized);
  const lemmaFromDict = hasOwnLemma ? lemmaDict[normalized] : undefined;
  const cacheKey = cache
    ? buildLemmaCandidateCacheKey(term, classes, lemmaFromDict, nlp !== null)
    : '';
  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const candidates: string[] = [];

  if (typeof lemmaFromDict === 'string' && lemmaFromDict.length > 0) {
    candidates.push(normalizeToken(lemmaFromDict));
  }

  const apostropheCandidates = buildApostropheLemmaCandidates(normalized);
  for (const candidate of apostropheCandidates) {
    candidates.push(candidate);
  }

  if (nlp) {
    try {
      const doc = nlp(term.raw);
      const verbInfinitive = normalizeToken(doc.verbs().toInfinitive().out('text'));
      const nounSingular = normalizeToken(doc.nouns().toSingular().out('text'));

      if (classes.verb) {
        candidates.push(verbInfinitive);
      }
      if (classes.noun) {
        candidates.push(nounSingular);
      }
      if (classes.adjective) {
        const adjective = extractConjugatedAdjective(doc);
        if (adjective.length > 0) {
          candidates.push(normalizeToken(adjective));
        }
      }

      candidates.push(verbInfinitive);
      candidates.push(nounSingular);
    } catch (error) {
      console.warn('compromise-lemmatization-failed', { raw: term.raw, error });
    }
  }

  candidates.push(normalized);

  const cleaned = candidates.filter((candidate) => candidate.length > 0 && WORD_TOKEN_RE.test(candidate));
  const unique = orderedUnique(cleaned);
  if (cache) {
    cache.set(cacheKey, unique);
  }
  return unique;
}

export function contextualDeinflectTaggedTerms(
  terms: TaggedTerm[],
  lemmaDict: Record<string, string>,
  lowerToIdx: Map<string, number>,
  properNounLexicon: Set<string>,
  excludeProperNouns: boolean,
  nlp: NlpLike | null,
  lemmaCandidateCache?: Map<string, string[]>,
): DeinflectionResult {
  const tokens: string[] = [];
  const properFlags: boolean[] = [];

  for (let index = 0; index < terms.length; index += 1) {
    const term = terms[index];
    const next = index < (terms.length - 1) ? terms[index + 1] : null;
    const normalized = normalizeToken(term.raw);
    const explicitProperTag = hasProperTag(term);
    const tagProper = isProperNounTag(term);
    const strongShapeProper = isStrongProperShapeTerm(term, next);
    const properByLexicon = explicitProperTag || strongShapeProper || (tagProper && properNounLexicon.has(normalized));
    properFlags.push(properByLexicon);

    if (excludeProperNouns && properByLexicon) {
      tokens.push('');
      continue;
    }

    const candidates = makeLemmaCandidates(term, lemmaDict, nlp, lemmaCandidateCache);
    const selectedFromVocab = candidates.find((candidate) => lowerToIdx.has(candidate));
    const selected = selectedFromVocab ?? candidates[0] ?? normalized;

    tokens.push(selected);
  }

  return { tokens, properFlags };
}
