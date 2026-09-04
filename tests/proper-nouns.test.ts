import test from 'node:test';
import assert from 'node:assert/strict';
import nlp from 'compromise';
import {
  buildTaggedSentences,
  buildHighConfidenceProperNounLexicon,
  contextualDeinflectTaggedTerms,
  inferPartsOfSpeech,
  tagSentenceTerms,
} from '../src/core/nlp.js';
import {
  analyzeChapter,
  buildBookLemmaHistogramAsync,
  createCachedChapterAnalyzer,
  createLexicalAnalysisCache,
} from '../src/core/reader-analysis.js';
import {
  resolveLexiconBucketFileName,
  resolveLexiconEntry,
} from '../src/core/lexicon.js';
import {
  buildDefinitionLookupCandidates,
  createDefinitionTarget,
  lookupFirstAvailableDefinition,
} from '../src/core/definition-target.js';
import { normalizeToken } from '../src/core/math.js';
import type {
  LexiconEntry,
  PartOfSpeech,
  ReaderSettings,
  TaggedSentence,
  TaggedTerm,
  UserProfile,
  VocabularyModel,
} from '../src/core/types.js';

function createStubNlpWithTaggedTerms(
  terms: Array<{ text: string; tags: Record<string, boolean> | string[] }>,
) {
  return (_text: string) => ({
    terms: () => ({
      json: () => terms.map((term) => ({ text: term.text, tags: term.tags })),
    }),
    verbs: () => ({ toInfinitive: () => ({ out: (_format: 'text') => '' }) }),
    nouns: () => ({ toSingular: () => ({ out: (_format: 'text') => '' }) }),
    adjectives: () => ({
      conjugate: () => [] as Array<Record<string, string>>,
    }),
  });
}

function createSentenceAwareStubNlp(
  termsBySentence: Record<
    string,
    Array<{ text: string; tags: Record<string, boolean> | string[] }>
  >,
) {
  return (text: string) => ({
    terms: () => ({
      json: () =>
        (termsBySentence[text] ?? []).map((term) => ({
          text: term.text,
          tags: term.tags,
        })),
    }),
    verbs: () => ({ toInfinitive: () => ({ out: (_format: 'text') => '' }) }),
    nouns: () => ({ toSingular: () => ({ out: (_format: 'text') => '' }) }),
    adjectives: () => ({
      conjugate: () => [] as Array<Record<string, string>>,
    }),
  });
}

function createStubNlpWithParentTaggedNestedTerms(
  terms: Array<{
    text: string;
    parentTags: Record<string, boolean> | string[];
  }>,
) {
  return (_text: string) => ({
    terms: () => ({
      json: () =>
        terms.map((term) => ({
          text: term.text,
          tags: term.parentTags,
          terms: [{ text: term.text }],
        })),
    }),
    verbs: () => ({ toInfinitive: () => ({ out: (_format: 'text') => '' }) }),
    nouns: () => ({ toSingular: () => ({ out: (_format: 'text') => '' }) }),
    adjectives: () => ({
      conjugate: () => [] as Array<Record<string, string>>,
    }),
  });
}

function createTaggedTerm(raw: string, sentenceInitial: boolean): TaggedTerm {
  return {
    raw,
    normalized: raw.toLowerCase(),
    tags: new Set<string>(),
    sentenceInitial,
  };
}

type LemmaForms = {
  verbInfinitive: string;
  nounSingular: string;
  adjectiveBase: string;
};

function createLemmaNlp(formsByToken: Record<string, LemmaForms>) {
  return (text: string) => {
    const normalized = normalizeToken(text);
    const forms = formsByToken[normalized];
    const verbInfinitive = forms ? forms.verbInfinitive : '';
    const nounSingular = forms ? forms.nounSingular : '';
    const adjectiveBase = forms ? forms.adjectiveBase : '';
    return {
      terms: () => ({
        json: () =>
          [] as Array<{
            text: string;
            tags: Record<string, boolean> | string[];
          }>,
      }),
      verbs: () => ({
        toInfinitive: () => ({ out: (_format: 'text') => verbInfinitive }),
      }),
      nouns: () => ({
        toSingular: () => ({ out: (_format: 'text') => nounSingular }),
      }),
      adjectives: () => ({
        conjugate: () =>
          adjectiveBase.length > 0 ? [{ adjective: adjectiveBase }] : [],
      }),
    };
  };
}

function buildLowerToIdxForExpectedLemmas(
  terms: TaggedTerm[],
  expectedPairs: Array<{ token: string; lemma: string }>,
): Map<string, number> {
  const expectedTokenSet = new Set<string>(
    expectedPairs.map((pair) => normalizeToken(pair.token)),
  );
  const vocab: string[] = [];

  for (const term of terms) {
    if (expectedTokenSet.has(term.normalized)) {
      continue;
    }
    vocab.push(term.normalized);
  }
  for (const pair of expectedPairs) {
    vocab.push(normalizeToken(pair.lemma));
  }

  const lowerToIdx = new Map<string, number>();
  for (const token of vocab) {
    if (!lowerToIdx.has(token)) {
      lowerToIdx.set(token, lowerToIdx.size);
    }
  }
  return lowerToIdx;
}

function assertSentenceDeinflection(
  sentence: string,
  expectedPairs: Array<{ token: string; lemma: string }>,
  formsByToken: Record<string, LemmaForms>,
) {
  const terms = tagSentenceTerms(sentence, null);
  const lowerToIdx = buildLowerToIdxForExpectedLemmas(terms, expectedPairs);
  const nlp = createLemmaNlp(formsByToken);
  const result = contextualDeinflectTaggedTerms(
    terms,
    {},
    lowerToIdx,
    new Set<string>(),
    false,
    nlp,
  );

  assert.equal(
    result.tokens.length,
    terms.length,
    `Token count mismatch for sentence: ${sentence}`,
  );
  for (const token of result.tokens) {
    assert.notEqual(
      token,
      '',
      `Unexpected filtered token while deinflecting: ${sentence}`,
    );
  }

  for (const pair of expectedPairs) {
    const normalizedToken = normalizeToken(pair.token);
    const normalizedLemma = normalizeToken(pair.lemma);
    let found = false;
    for (let index = 0; index < terms.length; index += 1) {
      if (terms[index].normalized !== normalizedToken) {
        continue;
      }
      found = true;
      assert.equal(
        result.tokens[index],
        normalizedLemma,
        `Expected '${pair.token}' -> '${pair.lemma}' in sentence: ${sentence}`,
      );
    }
    assert.equal(
      found,
      true,
      `Token '${pair.token}' not found in sentence: ${sentence}`,
    );
  }
}

function assertSentenceDeinflectionWithCompromiseRuntime(
  sentence: string,
  expectedPairs: Array<{ token: string; lemma: string }>,
) {
  const terms = tagSentenceTerms(sentence, nlp);
  const lowerToIdx = buildLowerToIdxForExpectedLemmas(terms, expectedPairs);
  const result = contextualDeinflectTaggedTerms(
    terms,
    {},
    lowerToIdx,
    new Set<string>(),
    false,
    nlp,
  );

  assert.equal(
    result.tokens.length,
    terms.length,
    `Token count mismatch for sentence: ${sentence}`,
  );
  for (const token of result.tokens) {
    assert.notEqual(
      token,
      '',
      `Unexpected filtered token while deinflecting: ${sentence}`,
    );
  }

  for (const pair of expectedPairs) {
    const normalizedToken = normalizeToken(pair.token);
    const normalizedLemma = normalizeToken(pair.lemma);
    let found = false;
    for (let index = 0; index < terms.length; index += 1) {
      if (terms[index].normalized !== normalizedToken) {
        continue;
      }
      found = true;
      assert.equal(
        result.tokens[index],
        normalizedLemma,
        `Expected '${pair.token}' -> '${pair.lemma}' in sentence: ${sentence}`,
      );
    }
    assert.equal(
      found,
      true,
      `Token '${pair.token}' not found in sentence: ${sentence}`,
    );
  }
}

function assertSentencePartsOfSpeech(
  sentence: string,
  expected: Array<{ token: string; partOfSpeech: PartOfSpeech | null }>,
): void {
  const terms = tagSentenceTerms(sentence, nlp);
  const partsOfSpeech = inferPartsOfSpeech(terms);

  assert.equal(
    partsOfSpeech.length,
    terms.length,
    `POS count mismatch for sentence: ${sentence}`,
  );
  assert.deepEqual(
    terms.map((term, index) => ({
      token: term.normalized,
      partOfSpeech: partsOfSpeech[index],
    })),
    expected,
  );
}

function assertTargetPartOfSpeech(
  sentence: string,
  target: string,
  expected: PartOfSpeech | null,
): void {
  const terms = tagSentenceTerms(sentence, nlp);
  const targetIndex = terms.findIndex(
    (term) => term.normalized === normalizeToken(target),
  );
  assert.notEqual(targetIndex, -1, `Token '${target}' not found: ${sentence}`);
  assert.equal(
    inferPartsOfSpeech(terms)[targetIndex],
    expected,
    `Unexpected POS for '${target}' in: ${sentence}`,
  );
}

test('POS inference applies conservative corrections from reader failures', () => {
  const cases: Array<{
    sentence: string;
    target: string;
    expected: PartOfSpeech | null;
  }> = [
    {
      sentence: "There's no use in sending presents to one's own feet.",
      target: 'presents',
      expected: 'noun',
    },
    {
      sentence: 'Seals, turtles, salmon, and so on; they all move about.',
      target: 'Seals',
      expected: 'noun',
    },
    {
      sentence: 'There are no fees or charges.',
      target: 'charges',
      expected: 'noun',
    },
    {
      sentence: 'Are you content now?',
      target: 'content',
      expected: null,
    },
    {
      sentence: 'Point D is the same distance from points A, B and C.',
      target: 'points',
      expected: 'noun',
    },
    {
      sentence: 'A bright idea of mine, said Ford.',
      target: 'mine',
      expected: 'pronoun',
    },
    {
      sentence: 'You are bound to feel nervous.',
      target: 'bound',
      expected: 'adjective',
    },
    {
      sentence: 'He was a friend of mine.',
      target: 'mine',
      expected: 'pronoun',
    },
    {
      sentence: 'Yours or mine?',
      target: 'mine',
      expected: 'pronoun',
    },
    {
      sentence: 'They take the finest laser-measuring equipment.',
      target: 'finest',
      expected: 'adjective',
    },
    {
      sentence: 'A desk of finest ultramahogany stood there.',
      target: 'finest',
      expected: 'adjective',
    },
  ];

  for (const sample of cases) {
    assertTargetPartOfSpeech(sample.sentence, sample.target, sample.expected);
  }
});

test('POS confidence and corrections avoid nearby false positives', () => {
  assertTargetPartOfSpeech('They mine coal here.', 'mine', 'verb');
  assertTargetPartOfSpeech('He presents the award.', 'presents', 'verb');
  assertTargetPartOfSpeech('The forest floor was wet.', 'forest', 'noun');
  assertTargetPartOfSpeech('They charge fees for entry.', 'charge', 'verb');

  const ambiguousTerm: TaggedTerm = {
    raw: 'record',
    normalized: 'record',
    tags: new Set<string>(['Noun', 'Verb']),
    sentenceInitial: false,
  };
  assert.equal(inferPartsOfSpeech([ambiguousTerm])[0], null);
});

test('contextual POS inference handles the provided Hitchhiker sentence', () => {
  const sentence =
    'On Wednesday night it had rained very heavily, the lane was wet and muddy, but the Thursday morning sun was bright and clear as it shone on Arthur Dent’s house for what was to be the last time.';

  assertSentencePartsOfSpeech(sentence, [
    { token: 'on', partOfSpeech: 'preposition' },
    { token: 'wednesday', partOfSpeech: 'noun' },
    { token: 'night', partOfSpeech: 'noun' },
    { token: 'it', partOfSpeech: 'pronoun' },
    { token: 'had', partOfSpeech: 'verb' },
    { token: 'rained', partOfSpeech: 'verb' },
    { token: 'very', partOfSpeech: 'adverb' },
    { token: 'heavily', partOfSpeech: 'adverb' },
    { token: 'the', partOfSpeech: 'article' },
    { token: 'lane', partOfSpeech: 'noun' },
    { token: 'was', partOfSpeech: 'verb' },
    { token: 'wet', partOfSpeech: 'adjective' },
    { token: 'and', partOfSpeech: 'conjunction' },
    { token: 'muddy', partOfSpeech: 'adjective' },
    { token: 'but', partOfSpeech: 'conjunction' },
    { token: 'the', partOfSpeech: 'article' },
    { token: 'thursday', partOfSpeech: 'noun' },
    { token: 'morning', partOfSpeech: 'noun' },
    { token: 'sun', partOfSpeech: 'noun' },
    { token: 'was', partOfSpeech: 'verb' },
    { token: 'bright', partOfSpeech: 'adjective' },
    { token: 'and', partOfSpeech: 'conjunction' },
    { token: 'clear', partOfSpeech: 'adjective' },
    { token: 'as', partOfSpeech: 'preposition' },
    { token: 'it', partOfSpeech: 'pronoun' },
    { token: 'shone', partOfSpeech: 'verb' },
    { token: 'on', partOfSpeech: 'preposition' },
    { token: 'arthur', partOfSpeech: 'proper-noun' },
    { token: "dent's", partOfSpeech: 'proper-noun' },
    { token: 'house', partOfSpeech: 'noun' },
    { token: 'for', partOfSpeech: 'preposition' },
    { token: 'what', partOfSpeech: 'pronoun' },
    { token: 'was', partOfSpeech: 'verb' },
    { token: 'to', partOfSpeech: 'particle' },
    { token: 'be', partOfSpeech: 'verb' },
    { token: 'the', partOfSpeech: 'article' },
    { token: 'last', partOfSpeech: 'adjective' },
    { token: 'time', partOfSpeech: 'noun' },
  ]);
});

test('contextual deinflection corrects slung to sling as a verb', () => {
  const sentence =
    'It nestled in the darkness inside a leather satchel which Ford Prefect habitually wore slung around his neck.';
  const terms = tagSentenceTerms(sentence, nlp);
  const lowerToIdx = buildLowerToIdxForExpectedLemmas(terms, [
    { token: 'slung', lemma: 'sling' },
  ]);
  const result = contextualDeinflectTaggedTerms(
    terms,
    { slung: 'sling' },
    lowerToIdx,
    new Set<string>(),
    false,
    nlp,
  );
  const slungIndex = terms.findIndex((term) => term.normalized === 'slung');

  assert.notEqual(slungIndex, -1);
  assert.equal(result.tokens[slungIndex], 'sling');
  assert.equal(result.partsOfSpeech[slungIndex], 'verb');
});

test('contextual POS inference preserves genuine verb and noun ambiguity', () => {
  assertSentencePartsOfSpeech('They night the room.', [
    { token: 'they', partOfSpeech: 'pronoun' },
    { token: 'night', partOfSpeech: 'verb' },
    { token: 'the', partOfSpeech: 'article' },
    { token: 'room', partOfSpeech: 'noun' },
  ]);

  assertSentencePartsOfSpeech('I record the record.', [
    { token: 'i', partOfSpeech: 'pronoun' },
    { token: 'record', partOfSpeech: 'verb' },
    { token: 'the', partOfSpeech: 'article' },
    { token: 'record', partOfSpeech: 'noun' },
  ]);
});

test('compromise object tags are parsed and explicit proper names are excluded', () => {
  const nlp = createStubNlpWithTaggedTerms([
    { text: 'USA', tags: { Acronym: true } },
    { text: 'met', tags: { Verb: true } },
    { text: 'England', tags: { Country: true } },
    { text: 'James', tags: { FirstName: true } },
    { text: 'Legge', tags: { LastName: true } },
  ]);

  const tagged = tagSentenceTerms('USA met England James Legge', nlp);
  assert.equal(tagged.length, 5);
  assert.equal(tagged[0].tags.has('Acronym'), true);
  assert.equal(tagged[2].tags.has('Country'), true);
  assert.equal(tagged[3].tags.has('FirstName'), true);
  assert.equal(tagged[4].tags.has('LastName'), true);

  const lowerToIdx = new Map<string, number>([
    ['usa', 0],
    ['met', 1],
    ['england', 2],
    ['james', 3],
    ['legge', 4],
  ]);
  const result = contextualDeinflectTaggedTerms(
    tagged,
    {},
    lowerToIdx,
    new Set<string>(),
    true,
    null,
  );

  assert.deepEqual(result.tokens, ['', 'met', '', '', '']);
  assert.deepEqual(result.properFlags, [true, false, true, true, true]);
});

test('parent-level compromise tags propagate to nested term nodes', () => {
  const nlp = createStubNlpWithParentTaggedNestedTerms([
    { text: 'USA', parentTags: { Acronym: true } },
    { text: 'England', parentTags: { Country: true } },
    { text: 'James', parentTags: { FirstName: true } },
    { text: 'Legge', parentTags: { LastName: true } },
    { text: 'work', parentTags: { Noun: true } },
  ]);

  const tagged = tagSentenceTerms('USA England James Legge work', nlp);
  const lowerToIdx = new Map<string, number>([
    ['usa', 0],
    ['england', 1],
    ['james', 2],
    ['legge', 3],
    ['work', 4],
  ]);

  const result = contextualDeinflectTaggedTerms(
    tagged,
    {},
    lowerToIdx,
    new Set<string>(),
    true,
    null,
  );
  assert.deepEqual(result.tokens, ['', '', '', '', 'work']);
  assert.deepEqual(result.properFlags, [true, true, true, true, false]);
});

test('heuristic capitalization stays lexicon-gated to avoid over-filtering', () => {
  const terms = [createTaggedTerm('England', true)];
  const lowerToIdx = new Map<string, number>([['england', 0]]);

  const withoutLexicon = contextualDeinflectTaggedTerms(
    terms,
    {},
    lowerToIdx,
    new Set<string>(),
    true,
    null,
  );
  assert.deepEqual(withoutLexicon.tokens, ['england']);
  assert.deepEqual(withoutLexicon.properFlags, [false]);

  const withLexicon = contextualDeinflectTaggedTerms(
    terms,
    {},
    lowerToIdx,
    new Set<string>(['england']),
    true,
    null,
  );
  assert.deepEqual(withLexicon.tokens, ['']);
  assert.deepEqual(withLexicon.properFlags, [true]);
});

test('fallback shape detection excludes USA, England, and James Legge without NLP tags', () => {
  const lowerToIdx = new Map<string, number>([
    ['usa', 0],
    ['england', 1],
    ['james', 2],
    ['legge', 3],
    ['professor', 4],
    ['work', 5],
  ]);

  const sentenceOneTerms: TaggedTerm[] = [
    createTaggedTerm('The', true),
    createTaggedTerm('professor', false),
    createTaggedTerm('in', false),
    createTaggedTerm('the', false),
    createTaggedTerm('USA', false),
    createTaggedTerm('and', false),
    createTaggedTerm('England', false),
  ];

  const sentenceTwoTerms: TaggedTerm[] = [
    createTaggedTerm('Finally', true),
    createTaggedTerm('James', false),
    createTaggedTerm('Legge', false),
    createTaggedTerm('finished', false),
    createTaggedTerm('the', false),
    createTaggedTerm('work', false),
  ];

  const one = contextualDeinflectTaggedTerms(
    sentenceOneTerms,
    {},
    lowerToIdx,
    new Set<string>(),
    true,
    null,
  );
  const two = contextualDeinflectTaggedTerms(
    sentenceTwoTerms,
    {},
    lowerToIdx,
    new Set<string>(),
    true,
    null,
  );

  assert.deepEqual(one.tokens, [
    'the',
    'professor',
    'in',
    'the',
    '',
    'and',
    '',
  ]);
  assert.deepEqual(two.tokens, ['finally', '', '', 'finished', 'the', 'work']);

  assert.deepEqual(one.properFlags, [
    false,
    false,
    false,
    false,
    true,
    false,
    true,
  ]);
  assert.deepEqual(two.properFlags, [false, true, true, false, false, false]);
});

test('high-confidence lexicon matches canonical dent/monday vector', () => {
  const taggedSentences: TaggedSentence[] = [
    {
      text: 'Arthur Dent',
      terms: [
        {
          raw: 'Arthur',
          normalized: 'arthur',
          tags: new Set<string>(['ProperNoun']),
          sentenceInitial: true,
        },
        {
          raw: 'Dent',
          normalized: 'dent',
          tags: new Set<string>(['ProperNoun']),
          sentenceInitial: false,
        },
      ],
    },
    {
      text: 'He met Dent',
      terms: [
        createTaggedTerm('He', true),
        createTaggedTerm('met', false),
        {
          raw: 'Dent',
          normalized: 'dent',
          tags: new Set<string>(['ProperNoun']),
          sentenceInitial: false,
        },
      ],
    },
    {
      text: 'Again Dent',
      terms: [
        createTaggedTerm('Again', true),
        {
          raw: 'Dent',
          normalized: 'dent',
          tags: new Set<string>(['ProperNoun']),
          sentenceInitial: false,
        },
      ],
    },
    {
      text: 'Monday arrived',
      terms: [
        {
          raw: 'Monday',
          normalized: 'monday',
          tags: new Set<string>(['ProperNoun']),
          sentenceInitial: true,
        },
        createTaggedTerm('arrived', false),
      ],
    },
    {
      text: 'Monday left',
      terms: [
        {
          raw: 'Monday',
          normalized: 'monday',
          tags: new Set<string>(['ProperNoun']),
          sentenceInitial: true,
        },
        createTaggedTerm('left', false),
      ],
    },
  ];

  const lexicon = buildHighConfidenceProperNounLexicon(taggedSentences);
  assert.equal(lexicon.has('dent'), true);
  assert.equal(lexicon.has('monday'), false);
});

test('provided multi-sentence sample excludes proper names from analysis', () => {
  const sentence1 =
    'The three translators are, first and foremost, the excellent translator of the first seven chapters, Fung Yu-Lan, professor of Chinese in the USA and China during most of this century.';
  const sentence2 =
    'Finally, that master of translation – not necessarily for the ease of his translation but for the depth of his work – James Legge.';
  const sentence3 =
    'Except in the United States of America, this book is sold subjectto the condition that it shall not, by way of trade or otherwise, be lent,re-sold, hired out, or otherwise circulated without the publisher’sprior consent in any form of binding or cover other than that inwhich it is published and without a similar condition including thiscondition being imposed on the subsequent purchaser';

  const nlp = createSentenceAwareStubNlp({
    [sentence1]: [
      { text: 'The', tags: { Determiner: true } },
      { text: 'three', tags: { Value: true } },
      { text: 'translators', tags: { Noun: true } },
      { text: 'Fung', tags: { FirstName: true } },
      { text: 'Yu', tags: { LastName: true } },
      { text: 'Lan', tags: { LastName: true } },
      { text: 'Chinese', tags: { Demonym: true } },
      { text: 'USA', tags: { Acronym: true } },
      { text: 'China', tags: { Country: true } },
      { text: 'century', tags: { Noun: true } },
    ],
    [sentence2]: [
      { text: 'Finally', tags: { Adverb: true } },
      { text: 'master', tags: { Noun: true } },
      { text: 'translation', tags: { Noun: true } },
      { text: 'James', tags: { FirstName: true } },
      { text: 'Legge', tags: { LastName: true } },
    ],
    [sentence3]: [
      { text: 'Except', tags: { Preposition: true } },
      { text: 'United', tags: { Place: true } },
      { text: 'States', tags: { Place: true } },
      { text: 'America', tags: { Country: true } },
      { text: 'book', tags: { Noun: true } },
      { text: 'publisher', tags: { Noun: true } },
      { text: 'purchaser', tags: { Noun: true } },
    ],
  });

  const text = `${sentence1} ${sentence2} ${sentence3}`;
  const taggedSentences = buildTaggedSentences(text, nlp);
  const properLexicon = buildHighConfidenceProperNounLexicon(taggedSentences);

  const lowerToIdx = new Map<string, number>([
    ['translator', 0],
    ['century', 1],
    ['master', 2],
    ['translation', 3],
    ['book', 4],
    ['publisher', 5],
    ['purchaser', 6],
    ['fung', 7],
    ['yu', 8],
    ['lan', 9],
    ['usa', 10],
    ['china', 11],
    ['james', 12],
    ['legge', 13],
    ['united', 14],
    ['states', 15],
    ['america', 16],
  ]);

  const taggedTerms = taggedSentences.flatMap((sentence) => sentence.terms);
  const result = contextualDeinflectTaggedTerms(
    taggedTerms,
    {},
    lowerToIdx,
    properLexicon,
    true,
    null,
  );

  const excluded = new Set<string>();
  for (let index = 0; index < taggedTerms.length; index += 1) {
    if (result.tokens[index] === '') {
      excluded.add(taggedTerms[index].normalized);
    }
  }

  assert.equal(excluded.has('usa'), true);
  assert.equal(excluded.has('china'), true);
  assert.equal(excluded.has('james'), true);
  assert.equal(excluded.has('legge'), true);
  assert.equal(excluded.has('united'), true);
  assert.equal(excluded.has('states'), true);
  assert.equal(excluded.has('america'), true);

  assert.equal(excluded.has('translator'), false);
  assert.equal(excluded.has('translation'), false);
  assert.equal(excluded.has('book'), false);
});

test('ten AiW sentences exclude proper nouns reliably', () => {
  const cases: Array<{
    sentence: string;
    taggedTerms: Array<{
      text: string;
      tags: Record<string, boolean> | string[];
    }>;
    expectedExcluded: string[];
    expectedIncluded: string[];
  }> = [
    {
      sentence:
        '“Give your evidence,” said the King; “and don’t be nervous, or I’ll have you executed on the spot.',
      taggedTerms: [
        { text: 'Give', tags: { Verb: true } },
        { text: 'evidence', tags: { Noun: true } },
        { text: 'King', tags: { ProperNoun: true } },
        { text: 'nervous', tags: { Adjective: true } },
      ],
      expectedExcluded: ['king'],
      expectedIncluded: ['evidence', 'nervous'],
    },
    {
      sentence:
        '“It wasn’t very civil of you to sit down without being invited,” said the March Hare.',
      taggedTerms: [
        { text: 'civil', tags: { Adjective: true } },
        { text: 'March', tags: { ProperNoun: true } },
        { text: 'Hare', tags: { ProperNoun: true } },
        { text: 'invited', tags: { Verb: true } },
      ],
      expectedExcluded: ['march', 'hare'],
      expectedIncluded: ['civil', 'invited'],
    },
    {
      sentence:
        '” Alice panted as she ran; but the Gryphon only answered “Come on!',
      taggedTerms: [
        { text: 'Alice', tags: { FirstName: true } },
        { text: 'panted', tags: { Verb: true } },
        { text: 'Gryphon', tags: { ProperNoun: true } },
        { text: 'answered', tags: { Verb: true } },
      ],
      expectedExcluded: ['alice', 'gryphon'],
      expectedIncluded: ['panted', 'answered'],
    },
    {
      sentence:
        '” “Call the first witness,” said the King; and the White Rabbit blew three blasts on the trumpet, and called out, “First witness!',
      taggedTerms: [
        { text: 'Call', tags: { Verb: true } },
        { text: 'witness', tags: { Noun: true } },
        { text: 'King', tags: { ProperNoun: true } },
        { text: 'White', tags: { ProperNoun: true } },
        { text: 'Rabbit', tags: { ProperNoun: true } },
        { text: 'trumpet', tags: { Noun: true } },
      ],
      expectedExcluded: ['king', 'white', 'rabbit'],
      expectedIncluded: ['witness', 'trumpet'],
    },
    {
      sentence:
        '” The Hatter opened his eyes very wide on hearing this; but all he _said_ was, “Why is a raven like a writing-desk?',
      taggedTerms: [
        { text: 'Hatter', tags: { ProperNoun: true } },
        { text: 'opened', tags: { Verb: true } },
        { text: 'raven', tags: { Noun: true } },
        { text: 'writing', tags: { Noun: true } },
      ],
      expectedExcluded: ['hatter'],
      expectedIncluded: ['raven', 'writing'],
    },
    {
      sentence:
        '“Well, I never heard it before,” said the Mock Turtle; “but it sounds uncommon nonsense.',
      taggedTerms: [
        { text: 'heard', tags: { Verb: true } },
        { text: 'Mock', tags: { ProperNoun: true } },
        { text: 'Turtle', tags: { ProperNoun: true } },
        { text: 'nonsense', tags: { Noun: true } },
      ],
      expectedExcluded: ['mock', 'turtle'],
      expectedIncluded: ['heard', 'nonsense'],
    },
    {
      sentence:
        'It was the White Rabbit returning, splendidly dressed, with a pair of white kid gloves in one hand and a large fan in the other: he came trotting along in a great hurry, muttering to himself as he came, “Oh!',
      taggedTerms: [
        { text: 'White', tags: { ProperNoun: true } },
        { text: 'Rabbit', tags: { ProperNoun: true } },
        { text: 'returning', tags: { Verb: true } },
        { text: 'gloves', tags: { Noun: true } },
        { text: 'hurry', tags: { Noun: true } },
      ],
      expectedExcluded: ['white', 'rabbit'],
      expectedIncluded: ['gloves', 'hurry'],
    },
    {
      sentence:
        '“Stand up and repeat ‘’_Tis the voice of the sluggard_,’” said the Gryphon.',
      taggedTerms: [
        { text: 'repeat', tags: { Verb: true } },
        { text: 'voice', tags: { Noun: true } },
        { text: 'sluggard', tags: { Noun: true } },
        { text: 'Gryphon', tags: { ProperNoun: true } },
      ],
      expectedExcluded: ['gryphon'],
      expectedIncluded: ['voice', 'sluggard'],
    },
    {
      sentence:
        'The Cat’s head began fading away the moment he was gone, and, by the time he had come back with the Duchess, it had entirely disappeared; so the King and the executioner ran wildly up and down looking for it, while the rest of the party went back to the game.',
      taggedTerms: [
        { text: 'Cat', tags: { ProperNoun: true } },
        { text: 'head', tags: { Noun: true } },
        { text: 'Duchess', tags: { ProperNoun: true } },
        { text: 'King', tags: { ProperNoun: true } },
        { text: 'executioner', tags: { Noun: true } },
      ],
      expectedExcluded: ['cat', 'duchess', 'king'],
      expectedIncluded: ['head', 'executioner'],
    },
    {
      sentence:
        '” said the Queen, “and take this young lady to see the Mock Turtle, and to hear his history.',
      taggedTerms: [
        { text: 'Queen', tags: { ProperNoun: true } },
        { text: 'young', tags: { Adjective: true } },
        { text: 'lady', tags: { Noun: true } },
        { text: 'Mock', tags: { ProperNoun: true } },
        { text: 'Turtle', tags: { ProperNoun: true } },
        { text: 'history', tags: { Noun: true } },
      ],
      expectedExcluded: ['queen', 'mock', 'turtle'],
      expectedIncluded: ['lady', 'history'],
    },
  ];

  for (const sample of cases) {
    const nlp = createStubNlpWithTaggedTerms(sample.taggedTerms);
    const tagged = tagSentenceTerms(sample.sentence, nlp);
    const lowerToIdx = new Map<string, number>(
      tagged.map((term, index) => [term.normalized, index]),
    );
    const result = contextualDeinflectTaggedTerms(
      tagged,
      {},
      lowerToIdx,
      new Set<string>(),
      true,
      null,
    );

    const excluded = new Set<string>();
    const included = new Set<string>();
    for (let index = 0; index < tagged.length; index += 1) {
      if (result.tokens[index] === '') {
        excluded.add(tagged[index].normalized);
      } else {
        included.add(tagged[index].normalized);
      }
    }

    for (const expected of sample.expectedExcluded) {
      assert.equal(
        excluded.has(expected),
        true,
        `Expected '${expected}' to be excluded in sentence: ${sample.sentence}`,
      );
    }
    for (const expected of sample.expectedIncluded) {
      assert.equal(
        included.has(expected),
        true,
        `Expected '${expected}' to remain included in sentence: ${sample.sentence}`,
      );
    }
  }
});

test('ten Hitchhikers sentences exclude proper nouns reliably', () => {
  const cases: Array<{
    sentence: string;
    taggedTerms: Array<{
      text: string;
      tags: Record<string, boolean> | string[];
    }>;
    expectedExcluded: string[];
    expectedIncluded: string[];
  }> = [
    {
      sentence:
        '“But unfortunately,” continued Ford, “it rather involved being on the other side of this airtight hatchway.',
      taggedTerms: [
        { text: 'Ford', tags: { Person: true } },
        { text: 'unfortunately', tags: { Adverb: true } },
        { text: 'involved', tags: { Verb: true } },
        { text: 'hatchway', tags: { Noun: true } },
      ],
      expectedExcluded: ['ford'],
      expectedIncluded: ['involved', 'hatchway'],
    },
    {
      sentence:
        'In The Hitchhiker’s Guide to the Galaxy, there’s a passage about the Vl’hurgs and their commander being “resplendent in his black jewelled battle shorts.',
      taggedTerms: [
        { text: 'Hitchhiker', tags: { ProperNoun: true } },
        { text: 'Guide', tags: { ProperNoun: true } },
        { text: 'Galaxy', tags: { ProperNoun: true } },
        { text: 'Vlhurgs', tags: { ProperNoun: true } },
        { text: 'passage', tags: { Noun: true } },
        { text: 'commander', tags: { Noun: true } },
      ],
      expectedExcluded: ['hitchhiker', 'guide', 'galaxy', 'vlhurgs'],
      expectedIncluded: ['passage', 'commander'],
    },
    {
      sentence:
        '“Yes, an electronic brain,” said Frankie, “a simple one would suffice.',
      taggedTerms: [
        { text: 'Frankie', tags: { FirstName: true } },
        { text: 'electronic', tags: { Adjective: true } },
        { text: 'brain', tags: { Noun: true } },
        { text: 'simple', tags: { Adjective: true } },
      ],
      expectedExcluded: ['frankie'],
      expectedIncluded: ['brain', 'simple'],
    },
    {
      sentence:
        'I mean, here we are on the run and everything, we must have the police of half the Galaxy after us by now, and we stop to pick up hitchhikers.',
      taggedTerms: [
        { text: 'Galaxy', tags: { ProperNoun: true } },
        { text: 'police', tags: { Noun: true } },
        { text: 'hitchhikers', tags: { Noun: true } },
        { text: 'everything', tags: { Noun: true } },
      ],
      expectedExcluded: ['galaxy'],
      expectedIncluded: ['police', 'hitchhikers'],
    },
    {
      sentence:
        '“It could always be replaced,” said Benjy reasonably, “if you think it’s important.',
      taggedTerms: [
        { text: 'Benjy', tags: { FirstName: true } },
        { text: 'replaced', tags: { Verb: true } },
        { text: 'reasonably', tags: { Adverb: true } },
        { text: 'important', tags: { Adjective: true } },
      ],
      expectedExcluded: ['benjy'],
      expectedIncluded: ['replaced', 'important'],
    },
    {
      sentence:
        '” “That is but the first half of the story, Earthman,” said the old man.',
      taggedTerms: [
        { text: 'Earthman', tags: { ProperNoun: true } },
        { text: 'story', tags: { Noun: true } },
        { text: 'old', tags: { Adjective: true } },
        { text: 'man', tags: { Noun: true } },
      ],
      expectedExcluded: ['earthman'],
      expectedIncluded: ['story', 'man'],
    },
    {
      sentence:
        '“Listen,” said Ford, who was still engrossed in the sales brochure, “they make a big thing of the ship’s cybernetics.',
      taggedTerms: [
        { text: 'Ford', tags: { Person: true } },
        { text: 'engrossed', tags: { Adjective: true } },
        { text: 'brochure', tags: { Noun: true } },
        { text: 'cybernetics', tags: { Noun: true } },
      ],
      expectedExcluded: ['ford'],
      expectedIncluded: ['brochure', 'cybernetics'],
    },
    {
      sentence:
        '” said the Queen, “and take this young lady to see the Mock Turtle, and to hear his history.',
      taggedTerms: [
        { text: 'Queen', tags: { ProperNoun: true } },
        { text: 'Mock', tags: { ProperNoun: true } },
        { text: 'Turtle', tags: { ProperNoun: true } },
        { text: 'lady', tags: { Noun: true } },
        { text: 'history', tags: { Noun: true } },
      ],
      expectedExcluded: ['queen', 'mock', 'turtle'],
      expectedIncluded: ['lady', 'history'],
    },
    {
      sentence:
        '“Well,” said Zaphod, attacking a boneful of grilled muscle, “our guests here have been gassing us and zapping our minds and being generally weird and have now given us a rather nice meal to make it up to us.',
      taggedTerms: [
        { text: 'Zaphod', tags: { ProperNoun: true } },
        { text: 'guests', tags: { Noun: true } },
        { text: 'minds', tags: { Noun: true } },
        { text: 'meal', tags: { Noun: true } },
      ],
      expectedExcluded: ['zaphod'],
      expectedIncluded: ['guests', 'meal'],
    },
    {
      sentence:
        '“There must be some mistake,” he said, “are you not a greater computer than the Milliard Gargantubrain at Maximegalon which can count all the atoms in a star in a millisecond?',
      taggedTerms: [
        { text: 'Milliard', tags: { ProperNoun: true } },
        { text: 'Gargantubrain', tags: { ProperNoun: true } },
        { text: 'Maximegalon', tags: { ProperNoun: true } },
        { text: 'computer', tags: { Noun: true } },
        { text: 'atoms', tags: { Noun: true } },
      ],
      expectedExcluded: ['milliard', 'gargantubrain', 'maximegalon'],
      expectedIncluded: ['computer', 'atoms'],
    },
  ];

  for (const sample of cases) {
    const nlp = createStubNlpWithTaggedTerms(sample.taggedTerms);
    const tagged = tagSentenceTerms(sample.sentence, nlp);
    const lowerToIdx = new Map<string, number>(
      tagged.map((term, index) => [term.normalized, index]),
    );
    const result = contextualDeinflectTaggedTerms(
      tagged,
      {},
      lowerToIdx,
      new Set<string>(),
      true,
      null,
    );

    const excluded = new Set<string>();
    const included = new Set<string>();
    for (let index = 0; index < tagged.length; index += 1) {
      if (result.tokens[index] === '') {
        excluded.add(tagged[index].normalized);
      } else {
        included.add(tagged[index].normalized);
      }
    }

    for (const expected of sample.expectedExcluded) {
      assert.equal(
        excluded.has(expected),
        true,
        `Expected '${expected}' to be excluded in sentence: ${sample.sentence}`,
      );
    }
    for (const expected of sample.expectedIncluded) {
      assert.equal(
        included.has(expected),
        true,
        `Expected '${expected}' to remain included in sentence: ${sample.sentence}`,
      );
    }
  }
});

test('contextual deinflection matches expected mappings for provided sentences', () => {
  const sentenceOne =
    'When the seas move, this bird too travels to the south darkness, the darkness known as the Pool of Heaven.';
  const sentenceTwo =
    'Is this its true colour? Or is it because it is so far away that it appears like this?';
  const sentenceThree =
    'Someone who goes into the countryside with his lunch, and returns in time for the evening meal will be as full as when he left.';
  const sentenceFour =
    'Concerning the record of the past actions of the kings in the Spring and Autumn Annals, the sage discusses but does not judge.';

  const formsByToken: Record<string, LemmaForms> = {
    seas: { verbInfinitive: '', nounSingular: 'sea', adjectiveBase: '' },
    travels: { verbInfinitive: 'travel', nounSingular: '', adjectiveBase: '' },
    appears: { verbInfinitive: 'appear', nounSingular: '', adjectiveBase: '' },
    returns: { verbInfinitive: 'return', nounSingular: '', adjectiveBase: '' },
    actions: { verbInfinitive: '', nounSingular: 'action', adjectiveBase: '' },
    kings: { verbInfinitive: '', nounSingular: 'king', adjectiveBase: '' },
    discusses: {
      verbInfinitive: 'discuss',
      nounSingular: '',
      adjectiveBase: '',
    },
  };

  assertSentenceDeinflection(
    sentenceOne,
    [
      { token: 'seas', lemma: 'sea' },
      { token: 'travels', lemma: 'travel' },
    ],
    formsByToken,
  );
  assertSentenceDeinflection(
    sentenceTwo,
    [{ token: 'appears', lemma: 'appear' }],
    formsByToken,
  );
  assertSentenceDeinflection(
    sentenceThree,
    [{ token: 'returns', lemma: 'return' }],
    formsByToken,
  );
  assertSentenceDeinflection(
    sentenceFour,
    [
      { token: 'actions', lemma: 'action' },
      { token: 'kings', lemma: 'king' },
    ],
    formsByToken,
  );
});

test('ten AiW sentences run contextual deinflection with expected lemmas', () => {
  const formsByToken: Record<string, LemmaForms> = {
    sitting: { verbInfinitive: 'sit', nounSingular: '', adjectiveBase: '' },
    considering: {
      verbInfinitive: 'consider',
      nounSingular: '',
      adjectiveBase: '',
    },
    daisies: { verbInfinitive: '', nounSingular: 'daisy', adjectiveBase: '' },
    doors: { verbInfinitive: '', nounSingular: 'door', adjectiveBase: '' },
    looked: { verbInfinitive: 'look', nounSingular: '', adjectiveBase: '' },
    words: { verbInfinitive: '', nounSingular: 'word', adjectiveBase: '' },
    lamps: { verbInfinitive: '', nounSingular: 'lamp', adjectiveBase: '' },
    gardeners: {
      verbInfinitive: '',
      nounSingular: 'gardener',
      adjectiveBase: '',
    },
    dates: { verbInfinitive: '', nounSingular: 'date', adjectiveBase: '' },
    soldiers: {
      verbInfinitive: '',
      nounSingular: 'soldier',
      adjectiveBase: '',
    },
    hedgehogs: {
      verbInfinitive: '',
      nounSingular: 'hedgehog',
      adjectiveBase: '',
    },
  };

  const cases: Array<{
    sentence: string;
    expectedPairs: Array<{ token: string; lemma: string }>;
  }> = [
    {
      sentence:
        'Alice was beginning to get very tired of sitting by her sister on the bank.',
      expectedPairs: [{ token: 'sitting', lemma: 'sit' }],
    },
    {
      sentence:
        'So she was considering in her own mind whether the pleasure of making a daisy-chain would be worth the trouble of getting up and picking the daisies.',
      expectedPairs: [
        { token: 'considering', lemma: 'consider' },
        { token: 'daisies', lemma: 'daisy' },
      ],
    },
    {
      sentence:
        'There were doors all round the hall, but they were all locked.',
      expectedPairs: [{ token: 'doors', lemma: 'door' }],
    },
    {
      sentence:
        'The rabbit took a watch out of its waistcoat-pocket, and looked at it, and then hurried on.',
      expectedPairs: [{ token: 'looked', lemma: 'look' }],
    },
    {
      sentence:
        'Alice had no idea what Latitude was, or Longitude either, but thought they were nice grand words to say.',
      expectedPairs: [{ token: 'words', lemma: 'word' }],
    },
    {
      sentence: 'The lamps were burning, and the cups were full.',
      expectedPairs: [{ token: 'lamps', lemma: 'lamp' }],
    },
    {
      sentence: 'The gardeners were painting the white roses red.',
      expectedPairs: [{ token: 'gardeners', lemma: 'gardener' }],
    },
    {
      sentence:
        'The jurymen were writing down all three dates on their slates.',
      expectedPairs: [{ token: 'dates', lemma: 'date' }],
    },
    {
      sentence: 'The soldiers were silent and looked at the Queen.',
      expectedPairs: [{ token: 'soldiers', lemma: 'soldier' }],
    },
    {
      sentence: 'The hedgehogs were engaged in fighting with each other.',
      expectedPairs: [{ token: 'hedgehogs', lemma: 'hedgehog' }],
    },
  ];

  for (const sample of cases) {
    assertSentenceDeinflection(
      sample.sentence,
      sample.expectedPairs,
      formsByToken,
    );
  }
});

test('ten Hitchhikers sentences run contextual deinflection with expected lemmas', () => {
  const formsByToken: Record<string, LemmaForms> = {
    blinked: { verbInfinitive: 'blink', nounSingular: '', adjectiveBase: '' },
    screens: { verbInfinitive: '', nounSingular: 'screen', adjectiveBase: '' },
    grabbed: { verbInfinitive: 'grab', nounSingular: '', adjectiveBase: '' },
    towels: { verbInfinitive: '', nounSingular: 'towel', adjectiveBase: '' },
    voices: { verbInfinitive: '', nounSingular: 'voice', adjectiveBase: '' },
    mutters: { verbInfinitive: 'mutter', nounSingular: '', adjectiveBase: '' },
    watches: { verbInfinitive: 'watch', nounSingular: '', adjectiveBase: '' },
    robots: { verbInfinitive: '', nounSingular: 'robot', adjectiveBase: '' },
    shuffled: {
      verbInfinitive: 'shuffle',
      nounSingular: '',
      adjectiveBase: '',
    },
    glances: { verbInfinitive: '', nounSingular: 'glance', adjectiveBase: '' },
    calculated: {
      verbInfinitive: 'calculate',
      nounSingular: '',
      adjectiveBase: '',
    },
    passengers: {
      verbInfinitive: '',
      nounSingular: 'passenger',
      adjectiveBase: '',
    },
  };

  const cases: Array<{
    sentence: string;
    expectedPairs: Array<{ token: string; lemma: string }>;
  }> = [
    {
      sentence: 'Arthur blinked at the screens and listened to the engines.',
      expectedPairs: [
        { token: 'blinked', lemma: 'blink' },
        { token: 'screens', lemma: 'screen' },
      ],
    },
    {
      sentence: 'Ford grabbed the towels and stuffed them into the satchel.',
      expectedPairs: [
        { token: 'grabbed', lemma: 'grab' },
        { token: 'towels', lemma: 'towel' },
      ],
    },
    {
      sentence: 'The voices echoed through the corridors of the ship.',
      expectedPairs: [{ token: 'voices', lemma: 'voice' }],
    },
    {
      sentence: 'Zaphod mutters and grins while the doors slide open.',
      expectedPairs: [{ token: 'mutters', lemma: 'mutter' }],
    },
    {
      sentence: 'Trillian watches the stars and writes notes.',
      expectedPairs: [{ token: 'watches', lemma: 'watch' }],
    },
    {
      sentence: 'The robots carry trays and answer questions.',
      expectedPairs: [{ token: 'robots', lemma: 'robot' }],
    },
    {
      sentence: 'Marvin shuffled across the decks and sighed.',
      expectedPairs: [{ token: 'shuffled', lemma: 'shuffle' }],
    },
    {
      sentence: 'They exchanged glances and whispered about probabilities.',
      expectedPairs: [{ token: 'glances', lemma: 'glance' }],
    },
    {
      sentence: 'The computers calculated routes and printed warnings.',
      expectedPairs: [{ token: 'calculated', lemma: 'calculate' }],
    },
    {
      sentence: 'Passengers hurried toward exits as alarms started ringing.',
      expectedPairs: [{ token: 'passengers', lemma: 'passenger' }],
    },
  ];

  for (const sample of cases) {
    assertSentenceDeinflection(
      sample.sentence,
      sample.expectedPairs,
      formsByToken,
    );
  }
});

test('Hitchhiker apostrophe forms deinflect to expected lemmas', () => {
  const formsByToken: Record<string, LemmaForms> = {
    "didn't": { verbInfinitive: 'do', nounSingular: '', adjectiveBase: '' },
    "arthur's": {
      verbInfinitive: '',
      nounSingular: 'Arthur',
      adjectiveBase: '',
    },
    "dingo's": { verbInfinitive: '', nounSingular: 'dingo', adjectiveBase: '' },
    "far's": { verbInfinitive: '', nounSingular: 'far', adjectiveBase: '' },
  };

  const cases: Array<{
    sentence: string;
    expectedPairs: Array<{ token: string; lemma: string }>;
  }> = [
    {
      sentence:
        'Ford Prefect knew that it didn’t matter a pair of dingo’s kidneys whether Arthur’s house got knocked down or not now.',
      expectedPairs: [
        { token: 'didn’t', lemma: 'do' },
        { token: 'Arthur’s', lemma: 'Arthur' },
        { token: 'dingo’s', lemma: 'dingo' },
      ],
    },
    {
      sentence: '“Oh yes,” said Arthur, “and how far’s that?”',
      expectedPairs: [{ token: 'far’s', lemma: 'far' }],
    },
  ];

  for (const sample of cases) {
    assertSentenceDeinflection(
      sample.sentence,
      sample.expectedPairs,
      formsByToken,
    );
  }
});

test('Hitchhiker apostrophe forms deinflect to expected lemmas with compromise runtime', () => {
  const cases: Array<{
    sentence: string;
    expectedPairs: Array<{ token: string; lemma: string }>;
  }> = [
    {
      sentence:
        'Ford Prefect knew that it didn’t matter a pair of dingo’s kidneys whether Arthur’s house got knocked down or not now.',
      expectedPairs: [
        { token: 'didn’t', lemma: 'do' },
        { token: 'Arthur’s', lemma: 'Arthur' },
        { token: 'dingo’s', lemma: 'dingo' },
      ],
    },
    {
      sentence: '“Oh yes,” said Arthur, “and how far’s that?”',
      expectedPairs: [{ token: 'far’s', lemma: 'far' }],
    },
  ];

  for (const sample of cases) {
    assertSentenceDeinflectionWithCompromiseRuntime(
      sample.sentence,
      sample.expectedPairs,
    );
  }
});

test('reader analysis retains short tokens without selecting them for cards', () => {
  const excerpt =
    '“Ah yes, Vogonity—sorry—of the poet’s compassionate soul”—Arthur felt he was on the homestretch now—“which contrives through the medium of the verse structure to sublimate this, transcend that, and come to terms with the fundamental dichotomies of the other”—he was reaching a triumphant crescendo—“and one is left with a profound and vivid insight into … into … er …” (which suddenly gave out on him). Ford leaped in with the coup de grace: “Into whatever it was the poem was about!” he yelled. Out of the corner of his mouth: “Well done, Arthur, that was very good.”';

  const chapter = {
    title: 'Excerpt',
    paragraphs: [excerpt],
  };
  const settings: ReaderSettings = {
    fontSize: 18,
    lineSpacing: 'Normal',
    fontChoice: 'Serif',
    pageWidth: 'Normal',
    maxWordsPerParagraph: 3,
    deduplicationRadius: 0,
    knowledgeThreshold: 0.6,
    englishVariant: 'US',
  };
  const model: VocabularyModel = {
    modelKey: 'test',
    modelName: 'test',
    words: [
      'vogonity',
      'compassionate',
      'soul',
      'homestretch',
      'fundamental',
      'dichotomies',
      'profound',
      'insight',
      'whatever',
    ],
    accuracy: [0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4],
    difficulties: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    wordToIdx: new Map<string, number>([
      ['vogonity', 0],
      ['compassionate', 1],
      ['soul', 2],
      ['homestretch', 3],
      ['fundamental', 4],
      ['dichotomies', 5],
      ['profound', 6],
      ['insight', 7],
      ['whatever', 8],
    ]),
    candidatePool: [],
    candidatePositions: new Map<string, number>(),
  };
  const profile: UserProfile = {
    id: 'p1',
    name: 'Test',
    observations: {},
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const analyses = analyzeChapter({
    chapter,
    settings,
    model,
    profile,
    lemmaDict: {},
    nlp: null,
    maxCardsPerParagraph: 3,
  });
  assert.equal(analyses.length, 1);

  const paragraph = analyses[0];
  for (const target of paragraph.cardTargets) {
    const letterCount = target.lemma.replace(/['’]/g, '').length;
    assert.ok(
      letterCount > 2,
      `Expected card lemma to be longer than 2 letters, got '${target.lemma}'`,
    );
  }

  const shortTokens = paragraph.tokens.filter((token) => {
    const normalized = normalizeToken(token.raw).replace(/['’]/g, '');
    return normalized.length <= 2;
  });
  assert.ok(shortTokens.length > 0);
  assert.ok(shortTokens.every((token) => token.unknown === false));
});

test('reader analysis keeps separate automatic targets for noun and verb usages', () => {
  const model: VocabularyModel = {
    modelKey: 'pos-test',
    modelName: 'pos-test',
    words: ['record'],
    accuracy: [0.4],
    difficulties: [0],
    wordToIdx: new Map<string, number>([['record', 0]]),
    candidatePool: [],
    candidatePositions: new Map<string, number>(),
  };
  const profile: UserProfile = {
    id: 'p1',
    name: 'Test',
    observations: {},
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const settings: ReaderSettings = {
    fontSize: 18,
    lineSpacing: 'Normal',
    fontChoice: 'Serif',
    pageWidth: 'Normal',
    maxWordsPerParagraph: 3,
    deduplicationRadius: 0,
    knowledgeThreshold: 0.6,
    englishVariant: 'US',
  };

  const analysis = analyzeChapter({
    chapter: { title: 'POS', paragraphs: ['I record the record.'] },
    settings,
    model,
    profile,
    lemmaDict: {},
    nlp,
    maxCardsPerParagraph: 3,
  })[0];

  assert.deepEqual(analysis.cardTargets, [
    { lemma: 'record', partOfSpeech: 'verb' },
    { lemma: 'record', partOfSpeech: 'noun' },
  ]);
});

test('cached chapter analysis preserves output and reuses lexical work across refreshes', () => {
  const model: VocabularyModel = {
    modelKey: 'cached-analysis-test',
    modelName: 'cached-analysis-test',
    words: ['record', 'room', 'night'],
    accuracy: [0.4, 0.4, 0.4],
    difficulties: [0, 0, 0],
    wordToIdx: new Map<string, number>([
      ['record', 0],
      ['room', 1],
      ['night', 2],
    ]),
    candidatePool: [],
    candidatePositions: new Map<string, number>(),
  };
  const profile: UserProfile = {
    id: 'cached-analysis-profile',
    name: 'Cached Analysis',
    observations: {},
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const settings: ReaderSettings = {
    fontSize: 18,
    lineSpacing: 'Normal',
    fontChoice: 'Serif',
    pageWidth: 'Normal',
    maxWordsPerParagraph: 2,
    deduplicationRadius: 0,
    knowledgeThreshold: 0.6,
    englishVariant: 'US',
  };
  const paragraphs = ['I record the record.', 'They night the room.'];
  const expected = paragraphs.map(
    (paragraph) =>
      analyzeChapter({
        chapter: { title: 'Expected', paragraphs: [paragraph] },
        settings,
        model,
        profile,
        lemmaDict: {},
        nlp,
        maxCardsPerParagraph: 2,
        includeCards: false,
      })[0],
  );

  let nlpCallCount = 0;
  const countingNlp = ((text: string) => {
    nlpCallCount += 1;
    return nlp(text);
  }) as NonNullable<Parameters<typeof analyzeChapter>[0]['nlp']>;
  const lexicalCache = createLexicalAnalysisCache();
  const createAnalyzer = () =>
    createCachedChapterAnalyzer(
      {
        settings,
        model,
        profile,
        lemmaDict: {},
        nlp: countingNlp,
        maxCardsPerParagraph: 2,
        includeCards: false,
      },
      lexicalCache,
    );

  const firstAnalyzer = createAnalyzer();
  const first = paragraphs.map(
    (paragraph) =>
      firstAnalyzer({ title: 'Cached', paragraphs: [paragraph] })[0],
  );
  const callsAfterFirstPass = nlpCallCount;
  const secondAnalyzer = createAnalyzer();
  const second = paragraphs.map(
    (paragraph) =>
      secondAnalyzer({ title: 'Cached', paragraphs: [paragraph] })[0],
  );

  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected);
  assert.ok(callsAfterFirstPass > 0);
  assert.equal(nlpCallCount, callsAfterFirstPass);
});

test('async book analysis yields while tagging a single large chapter', async () => {
  let nlpCallCount = 0;
  let shouldContinue = true;
  const taggedNlp = createStubNlpWithTaggedTerms([
    { text: 'word', tags: { Noun: true } },
  ]);
  const countingNlp = ((text: string) => {
    nlpCallCount += 1;
    return taggedNlp(text);
  }) as NonNullable<Parameters<typeof analyzeChapter>[0]['nlp']>;
  const model: VocabularyModel = {
    modelKey: 'async-yield-test',
    modelName: 'async-yield-test',
    words: ['word'],
    accuracy: [0.5],
    difficulties: [0],
    wordToIdx: new Map<string, number>([['word', 0]]),
    candidatePool: [],
    candidatePositions: new Map<string, number>(),
  };

  const histogram = await buildBookLemmaHistogramAsync(
    {
      chapters: [
        { title: 'Long chapter', paragraphs: ['One.', 'Two.', 'Three.'] },
      ],
      currentChapter: 1,
    },
    model,
    {},
    countingNlp,
    {
      shouldContinue: () => shouldContinue,
      onYield: async () => {
        shouldContinue = false;
      },
      yieldEveryParagraphs: 1,
    },
  );

  assert.equal(histogram, null);
  assert.equal(nlpCallCount, 1);
});

test('lexicon resolution selects matching POS and otherwise exposes every group', () => {
  const entry: LexiconEntry = {
    word: 'record',
    senses: [
      { partOfSpeech: 'noun', ipa: '/noun/', definitions: ['A stored item.'] },
      {
        partOfSpeech: 'verb',
        ipa: '/verb/',
        definitions: ['To store information.'],
      },
    ],
  };

  const verbEntry = resolveLexiconEntry(entry, {
    lemma: 'record',
    partOfSpeech: 'verb',
  });
  assert.deepEqual(
    verbEntry.senses.map((sense) => sense.partOfSpeech),
    ['verb'],
  );

  const unmatchedEntry = resolveLexiconEntry(entry, {
    lemma: 'record',
    partOfSpeech: 'adjective',
  });
  assert.deepEqual(
    unmatchedEntry.senses.map((sense) => sense.partOfSpeech),
    ['noun', 'verb'],
  );

  const ambiguousEntry = resolveLexiconEntry(entry, {
    lemma: 'record',
    partOfSpeech: null,
  });
  assert.deepEqual(
    ambiguousEntry.senses.map((sense) => sense.partOfSpeech),
    ['noun', 'verb'],
  );
});

test('lazy lexicon bucket routing is stable for common, rare, and apostrophe words', () => {
  assert.equal(resolveLexiconBucketFileName('record'), '0204.json');
  assert.equal(resolveLexiconBucketFileName('zyzzyva'), '0026.json');
  assert.equal(resolveLexiconBucketFileName("don't"), '0365.json');
  assert.equal(resolveLexiconBucketFileName('Quomodocunquizing'), '0520.json');
});

test('hyphenated definition lookup prefers the compound before the clicked component', () => {
  const definition = 'Alternative form of dog-eared.';
  const componentStart = definition.indexOf('eared');
  const componentEnd = componentStart + 'eared'.length;
  const candidates = buildDefinitionLookupCandidates(
    definition,
    componentStart,
    componentEnd,
    createDefinitionTarget('ear', 'verb'),
  );

  assert.deepEqual(candidates, [
    {
      lookupWord: 'dog-eared',
      selectionEnd: definition.indexOf('dog-eared') + 'dog-eared'.length,
      selectionStart: definition.indexOf('dog-eared'),
      target: { lemma: 'dog-eared', partOfSpeech: null },
    },
    {
      lookupWord: 'eared',
      selectionEnd: componentEnd,
      selectionStart: componentStart,
      target: { lemma: 'ear', partOfSpeech: 'verb' },
    },
  ]);
});

test('compound lookup normalizes typographic hyphens but does not join em-dash words', () => {
  const hyphenatedText = 'A dog‑eared book.';
  const dogStart = hyphenatedText.indexOf('dog');
  const hyphenatedCandidates = buildDefinitionLookupCandidates(
    hyphenatedText,
    dogStart,
    dogStart + 'dog'.length,
    createDefinitionTarget('dog', 'noun'),
  );
  assert.deepEqual(hyphenatedCandidates[0], {
    lookupWord: 'dog‑eared',
    selectionEnd: dogStart + 'dog‑eared'.length,
    selectionStart: dogStart,
    target: { lemma: 'dog-eared', partOfSpeech: null },
  });

  const emDashText = 'gloves—that';
  const thatStart = emDashText.indexOf('that');
  const emDashCandidates = buildDefinitionLookupCandidates(
    emDashText,
    thatStart,
    thatStart + 'that'.length,
    createDefinitionTarget('that', 'determiner'),
  );
  assert.deepEqual(emDashCandidates, [
    {
      lookupWord: 'that',
      selectionEnd: thatStart + 'that'.length,
      selectionStart: thatStart,
      target: { lemma: 'that', partOfSpeech: 'determiner' },
    },
  ]);
});

test('definition lookup uses the component only after the compound is absent', async () => {
  const dogEaredEntry: LexiconEntry = {
    word: 'dog-eared',
    senses: [
      { partOfSpeech: 'adjective', ipa: '', definitions: ['Worn from use.'] },
    ],
  };
  const earEntry: LexiconEntry = {
    word: 'ear',
    senses: [{ partOfSpeech: 'verb', ipa: '', definitions: ['To form ears.'] }],
  };
  const lookupText = 'Alternative form of dog-eared.';
  const lookupStart = lookupText.indexOf('eared');
  const candidates = buildDefinitionLookupCandidates(
    lookupText,
    lookupStart,
    lookupStart + 'eared'.length,
    createDefinitionTarget('ear', 'verb'),
  );

  const compoundCalls: string[] = [];
  const compoundResult = await lookupFirstAvailableDefinition(
    {
      lookup: async (word) => {
        compoundCalls.push(word);
        return word === 'dog-eared' ? dogEaredEntry : null;
      },
    },
    candidates,
  );
  assert.deepEqual(compoundCalls, ['dog-eared']);
  assert.equal(compoundResult.entry?.word, 'dog-eared');
  assert.equal(compoundResult.candidate.target.partOfSpeech, null);
  assert.equal(
    compoundResult.candidate.selectionStart,
    lookupText.indexOf('dog-eared'),
  );
  assert.equal(
    compoundResult.candidate.selectionEnd,
    lookupText.indexOf('dog-eared') + 'dog-eared'.length,
  );

  const fallbackCalls: string[] = [];
  const fallbackResult = await lookupFirstAvailableDefinition(
    {
      lookup: async (word) => {
        fallbackCalls.push(word);
        return word === 'ear' ? earEntry : null;
      },
    },
    candidates,
  );
  assert.deepEqual(fallbackCalls, ['dog-eared', 'eared', 'ear']);
  assert.equal(fallbackResult.entry?.word, 'ear');
  assert.equal(fallbackResult.candidate.target.partOfSpeech, 'verb');
  assert.equal(fallbackResult.candidate.selectionStart, lookupStart);
  assert.equal(
    fallbackResult.candidate.selectionEnd,
    lookupStart + 'eared'.length,
  );
});
