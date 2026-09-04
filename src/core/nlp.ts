import {
  CALENDAR_EXCLUSIONS,
  SENTENCE_RE,
  TITLE_CASE_NOISE,
  WORD_RE,
  WORD_TOKEN_RE,
} from './constants';
import { isWordToken, normalizeToken, orderedUnique } from './math';
import type {
  DeinflectionResult,
  PartOfSpeech,
  TaggedSentence,
  TaggedTerm,
} from './types';

export interface SentenceSpan {
  text: string;
  start: number;
  end: number;
}

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

const ARTICLES = new Set<string>(['a', 'an', 'the']);

const CALENDAR_TIME_NOUNS = new Set<string>([
  'afternoon',
  'dawn',
  'day',
  'evening',
  'midday',
  'midnight',
  'morning',
  'night',
  'noon',
]);

const ADVERBIAL_QUESTION_WORDS = new Set<string>([
  'how',
  'when',
  'where',
  'why',
]);

const POSSESSIVE_PRONOUNS = new Set<string>([
  'hers',
  'ours',
  'theirs',
  'yours',
]);

// These forms are frequently tagged as nouns when they modify another noun.
// Keep this deliberately small: suffix-only detection would misclassify noun
// modifiers such as "forest floor" and "interest rate".
const HIGH_CONFIDENCE_SUPERLATIVE_ADJECTIVES = new Set<string>([
  'brightest',
  'darkest',
  'earliest',
  'fastest',
  'finest',
  'greatest',
  'highest',
  'largest',
  'latest',
  'longest',
  'lowest',
  'nearest',
  'oldest',
  'poorest',
  'richest',
  'safest',
  'shortest',
  'slowest',
  'smallest',
  'strongest',
  'weakest',
  'youngest',
]);

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

function extractCompromiseTermTags(
  rawTags: CompromiseTags | undefined,
): Set<string> {
  const normalizeTag = (tag: string) => tag.replace(/^#/, '').trim();

  if (Array.isArray(rawTags)) {
    return new Set<string>(
      rawTags
        .map((tag) => normalizeTag(String(tag)))
        .filter((tag) => tag.length > 0),
    );
  }
  if (rawTags && typeof rawTags === 'object') {
    return new Set<string>(
      Object.keys(rawTags)
        .map((tag) => normalizeTag(tag))
        .filter((tag) => tag.length > 0),
    );
  }
  return new Set<string>();
}

function flattenCompromiseTerms(
  jsonTerms: CompromiseTermNode[],
): Array<{ text: string; tags: Set<string> }> {
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
  return splitSentenceSpans(text).map((sentence) => sentence.text);
}

export function splitSentenceSpans(text: string): SentenceSpan[] {
  SENTENCE_RE.lastIndex = 0;
  const sentences: SentenceSpan[] = [];
  const matches = text.matchAll(SENTENCE_RE);
  for (const match of matches) {
    const rawChunk = match[0];
    const chunk = rawChunk.trim();
    if (chunk.length > 0) {
      const leadingWhitespace = rawChunk.length - rawChunk.trimStart().length;
      const start = (match.index ?? 0) + leadingWhitespace;
      sentences.push({ text: chunk, start, end: start + chunk.length });
    }
  }
  SENTENCE_RE.lastIndex = 0;
  return sentences;
}

export function tagSentenceTerms(
  sentence: string,
  nlp: NlpLike | null,
): TaggedTerm[] {
  if (!nlp) {
    return buildFallbackTerms(sentence);
  }

  try {
    const tagged = tagWithCompromise(sentence, nlp);
    if (tagged.length > 0) {
      return tagged;
    }
    return buildFallbackTerms(sentence);
  } catch (error) {
    console.warn('compromise-tagging-failed', { sentence, error });
    return buildFallbackTerms(sentence);
  }
}

export function buildTaggedSentences(
  text: string,
  nlp: NlpLike | null,
): TaggedSentence[] {
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

export function isNameLikeToken(
  raw: string,
  sentenceInitial: boolean,
): boolean {
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
    if (
      CALENDAR_EXCLUSIONS.has(normalized) ||
      TITLE_CASE_NOISE.has(normalized)
    ) {
      return false;
    }
    return true;
  }
  return isNameLikeToken(term.raw, term.sentenceInitial);
}

function isStrongProperShapeTerm(
  term: TaggedTerm,
  next: TaggedTerm | null,
): boolean {
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
    const nextIsTitleCaseWord =
      WORD_TOKEN_RE.test(next.raw) && isTitleCaseToken(next.raw);
    if (nextIsTitleCaseWord && !normalized.endsWith('ly')) {
      return true;
    }
  }

  return !term.sentenceInitial;
}

export function buildHighConfidenceProperNounLexicon(
  taggedSentences: TaggedSentence[],
): Set<string> {
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
      const normalized = term.normalized;
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
    if (value.proper / value.total < 0.6) {
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

function mapTagsToWordClass(tags: Set<string>): {
  verb: boolean;
  noun: boolean;
  adjective: boolean;
} {
  return {
    verb: tags.has('Verb'),
    noun: tags.has('Noun'),
    adjective: tags.has('Adjective'),
  };
}

export function inferPartOfSpeech(term: TaggedTerm): PartOfSpeech | null {
  const tags = term.tags;
  if (ARTICLES.has(term.normalized) && tags.has('Determiner')) {
    return 'article';
  }
  if (tags.has('Pronoun')) {
    return 'pronoun';
  }
  if (tags.has('Determiner')) {
    return 'determiner';
  }
  for (const tag of COMPROMISE_PROPER_TAGS) {
    if (tags.has(tag)) {
      return 'proper-noun';
    }
  }
  if (tags.has('Preposition')) {
    return 'preposition';
  }
  if (tags.has('Conjunction')) {
    return 'conjunction';
  }
  if (tags.has('Interjection')) {
    return 'interjection';
  }
  if (tags.has('Cardinal') || tags.has('Ordinal') || tags.has('Value')) {
    return 'numeral';
  }
  if (tags.has('Particle')) {
    return 'particle';
  }

  const openClassCandidates: PartOfSpeech[] = [];
  if (tags.has('Adverb')) {
    openClassCandidates.push('adverb');
  }
  if (tags.has('Adjective')) {
    openClassCandidates.push('adjective');
  }
  if (tags.has('Verb')) {
    openClassCandidates.push('verb');
  }
  if (tags.has('Noun')) {
    openClassCandidates.push('noun');
  }

  // Compromise can attach several incompatible open-class tags. Choosing by
  // tag priority is false confidence; null preserves all dictionary POS groups.
  return openClassCandidates.length === 1 ? openClassCandidates[0] : null;
}

function isCalendarTimeNoun(
  term: TaggedTerm,
  previous: TaggedTerm | null,
): boolean {
  if (
    !term.tags.has('Verb') ||
    !CALENDAR_TIME_NOUNS.has(term.normalized) ||
    previous === null
  ) {
    return false;
  }
  return (
    previous.tags.has('Date') ||
    previous.tags.has('WeekDay') ||
    previous.tags.has('Month')
  );
}

function inferQuestionWordPartOfSpeech(
  term: TaggedTerm,
  next: TaggedTerm | null,
): PartOfSpeech | null {
  if (!term.tags.has('QuestionWord')) {
    return null;
  }
  if (ADVERBIAL_QUESTION_WORDS.has(term.normalized)) {
    return 'adverb';
  }
  if (next !== null && (next.tags.has('Noun') || next.tags.has('Adjective'))) {
    return 'determiner';
  }
  return 'pronoun';
}

function isNominalTerm(term: TaggedTerm | null): boolean {
  if (term === null) {
    return false;
  }
  if (term.tags.has('Noun')) {
    return true;
  }
  for (const tag of COMPROMISE_PROPER_TAGS) {
    if (term.tags.has(tag)) {
      return true;
    }
  }
  return false;
}

function isPossessivePronounUse(
  term: TaggedTerm,
  previous: TaggedTerm | null,
  previousPrevious: TaggedTerm | null,
): boolean {
  if (POSSESSIVE_PRONOUNS.has(term.normalized)) {
    return true;
  }
  if (term.normalized !== 'mine') {
    return false;
  }
  return (
    previous?.normalized === 'of' ||
    previous?.tags.has('Copula') === true ||
    (previous?.tags.has('Conjunction') === true &&
      previousPrevious !== null &&
      (POSSESSIVE_PRONOUNS.has(previousPrevious.normalized) ||
        previousPrevious.normalized === 'mine'))
  );
}

function isSuperlativeNounModifier(
  term: TaggedTerm,
  next: TaggedTerm | null,
): boolean {
  return (
    HIGH_CONFIDENCE_SUPERLATIVE_ADJECTIVES.has(term.normalized) &&
    isNominalTerm(next)
  );
}

function isBoundToAdjective(
  term: TaggedTerm,
  previous: TaggedTerm | null,
  next: TaggedTerm | null,
  nextNext: TaggedTerm | null,
): boolean {
  return (
    term.normalized === 'bound' &&
    previous?.tags.has('Copula') === true &&
    next?.normalized === 'to' &&
    nextNext?.tags.has('Verb') === true
  );
}

function isCoordinatedNoun(
  term: TaggedTerm,
  previous: TaggedTerm | null,
  previousPrevious: TaggedTerm | null,
  inferredPartOfSpeech: PartOfSpeech | null,
): boolean {
  return (
    inferredPartOfSpeech === 'verb' &&
    term.tags.has('PresentTense') &&
    previous?.tags.has('Conjunction') === true &&
    isNominalTerm(previousPrevious)
  );
}

function isLeadingParallelNoun(
  term: TaggedTerm,
  next: TaggedTerm | null,
  nextNext: TaggedTerm | null,
  inferredPartOfSpeech: PartOfSpeech | null,
): boolean {
  return (
    inferredPartOfSpeech === 'verb' &&
    term.sentenceInitial &&
    term.tags.has('PresentTense') &&
    term.normalized.endsWith('s') &&
    isNominalTerm(next) &&
    isNominalTerm(nextNext)
  );
}

function isGerundObjectNoun(
  term: TaggedTerm,
  previous: TaggedTerm | null,
  next: TaggedTerm | null,
  inferredPartOfSpeech: PartOfSpeech | null,
): boolean {
  return (
    inferredPartOfSpeech === 'verb' &&
    term.tags.has('PresentTense') &&
    term.normalized.endsWith('s') &&
    previous?.tags.has('Gerund') === true &&
    (next?.normalized === 'to' || next?.normalized === 'for')
  );
}

function isPointLabelNoun(
  term: TaggedTerm,
  previous: TaggedTerm | null,
  next: TaggedTerm | null,
  inferredPartOfSpeech: PartOfSpeech | null,
): boolean {
  return (
    inferredPartOfSpeech === 'verb' &&
    (term.normalized === 'point' || term.normalized === 'points') &&
    previous?.tags.has('Preposition') === true &&
    next !== null &&
    (/^[A-Z]$/.test(next.raw) || next.tags.has('Acronym'))
  );
}

function isUncertainCopularComplement(
  previous: TaggedTerm | null,
  previousPrevious: TaggedTerm | null,
  inferredPartOfSpeech: PartOfSpeech | null,
): boolean {
  if (inferredPartOfSpeech !== 'noun') {
    return false;
  }
  return (
    previous?.tags.has('Copula') === true ||
    (previous?.tags.has('Pronoun') === true &&
      previousPrevious?.tags.has('Copula') === true)
  );
}

export function inferPartsOfSpeech(
  terms: TaggedTerm[],
): Array<PartOfSpeech | null> {
  return terms.map((term, index) => {
    const previous = index > 0 ? terms[index - 1] : null;
    const previousPrevious = index > 1 ? terms[index - 2] : null;
    const next = index < terms.length - 1 ? terms[index + 1] : null;
    const nextNext = index < terms.length - 2 ? terms[index + 2] : null;

    if (isCalendarTimeNoun(term, previous)) {
      return 'noun';
    }
    if (
      term.normalized === 'to' &&
      next !== null &&
      next.tags.has('Verb') &&
      next.tags.has('Infinitive')
    ) {
      return 'particle';
    }
    const questionWordPartOfSpeech = inferQuestionWordPartOfSpeech(term, next);
    if (questionWordPartOfSpeech !== null) {
      return questionWordPartOfSpeech;
    }

    const inferredPartOfSpeech = inferPartOfSpeech(term);
    if (isPossessivePronounUse(term, previous, previousPrevious)) {
      return 'pronoun';
    }
    if (isSuperlativeNounModifier(term, next)) {
      return 'adjective';
    }
    if (isBoundToAdjective(term, previous, next, nextNext)) {
      return 'adjective';
    }
    if (
      isCoordinatedNoun(
        term,
        previous,
        previousPrevious,
        inferredPartOfSpeech,
      ) ||
      isLeadingParallelNoun(term, next, nextNext, inferredPartOfSpeech) ||
      isGerundObjectNoun(term, previous, next, inferredPartOfSpeech) ||
      isPointLabelNoun(term, previous, next, inferredPartOfSpeech)
    ) {
      return 'noun';
    }
    if (
      isUncertainCopularComplement(
        previous,
        previousPrevious,
        inferredPartOfSpeech,
      )
    ) {
      return null;
    }
    return inferredPartOfSpeech;
  });
}

function resolveDeinflectedPartOfSpeech(
  term: TaggedTerm,
  previous: TaggedTerm | null,
  next: TaggedTerm | null,
  dictionaryLemma: string | null,
  inferredPartOfSpeech: PartOfSpeech | null,
): PartOfSpeech | null {
  if (
    inferredPartOfSpeech === 'noun' &&
    term.tags.has('Singular') &&
    dictionaryLemma !== null &&
    dictionaryLemma !== term.normalized &&
    previous?.tags.has('Verb') === true &&
    next?.tags.has('Preposition') === true
  ) {
    return 'verb';
  }
  return inferredPartOfSpeech;
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
  if (!normalizedToken.includes("'")) {
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
    if (
      normalizedToken.endsWith(suffix) &&
      normalizedToken.length > suffix.length
    ) {
      addCandidate(normalizedToken.slice(0, -suffix.length));
    }
  }

  if (normalizedToken.endsWith("n't") && normalizedToken.length > 3) {
    const contractionStem = normalizeToken(normalizedToken.slice(0, -3));
    addCandidate(contractionStem);

    const expandedStem =
      NEGATIVE_CONTRACTION_STEM_OVERRIDES[contractionStem] ?? contractionStem;
    addCandidate(expandedStem);

    const normalizedLemma =
      NEGATIVE_CONTRACTION_LEMMA_OVERRIDES[expandedStem] ??
      NEGATIVE_CONTRACTION_LEMMA_OVERRIDES[contractionStem];
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
  const normalizedLemmaFromDict =
    typeof lemmaFromDict === 'string' && lemmaFromDict.length > 0
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
  const normalized = term.normalized;
  const classes = mapTagsToWordClass(term.tags);
  const hasOwnLemma = Object.prototype.hasOwnProperty.call(
    lemmaDict,
    normalized,
  );
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
      const verbInfinitive = normalizeToken(
        doc.verbs().toInfinitive().out('text'),
      );
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

  const cleaned = candidates.filter(
    (candidate) => candidate.length > 0 && WORD_TOKEN_RE.test(candidate),
  );
  const unique = orderedUnique(cleaned);
  if (cache) {
    cache.set(cacheKey, unique);
  }
  return unique;
}

function resolveKnownDictionaryLemma(
  normalizedToken: string,
  lemmaDict: Record<string, string>,
  lowerToIdx: Map<string, number>,
): string | null {
  if (!Object.prototype.hasOwnProperty.call(lemmaDict, normalizedToken)) {
    return null;
  }
  const lemma = normalizeToken(lemmaDict[normalizedToken]);
  if (
    lemma.length === 0 ||
    !WORD_TOKEN_RE.test(lemma) ||
    !lowerToIdx.has(lemma)
  ) {
    return null;
  }
  return lemma;
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
  const partsOfSpeech: Array<PartOfSpeech | null> = [];
  const inferredPartsOfSpeech = inferPartsOfSpeech(terms);

  for (let index = 0; index < terms.length; index += 1) {
    const term = terms[index];
    const previous = index > 0 ? terms[index - 1] : null;
    const next = index < terms.length - 1 ? terms[index + 1] : null;
    const normalized = term.normalized;
    const explicitProperTag = hasProperTag(term);
    const tagProper = isProperNounTag(term);
    const strongShapeProper = isStrongProperShapeTerm(term, next);
    const properByLexicon =
      explicitProperTag ||
      strongShapeProper ||
      (tagProper && properNounLexicon.has(normalized));
    const dictionaryLemma = resolveKnownDictionaryLemma(
      normalized,
      lemmaDict,
      lowerToIdx,
    );
    const contextualPartOfSpeech = resolveDeinflectedPartOfSpeech(
      term,
      previous,
      next,
      dictionaryLemma,
      inferredPartsOfSpeech[index],
    );
    properFlags.push(properByLexicon);
    partsOfSpeech.push(
      properByLexicon ? 'proper-noun' : contextualPartOfSpeech,
    );

    if (excludeProperNouns && properByLexicon) {
      tokens.push('');
      continue;
    }

    if (dictionaryLemma !== null) {
      tokens.push(dictionaryLemma);
      continue;
    }

    const candidates = makeLemmaCandidates(
      term,
      lemmaDict,
      nlp,
      lemmaCandidateCache,
    );
    const selectedFromVocab = candidates.find((candidate) =>
      lowerToIdx.has(candidate),
    );
    const selected = selectedFromVocab ?? candidates[0] ?? normalized;

    tokens.push(selected);
  }

  return { tokens, properFlags, partsOfSpeech };
}
