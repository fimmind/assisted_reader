import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTaggedSentences,
  buildHighConfidenceProperNounLexicon,
  contextualDeinflectTaggedTerms,
  tagSentenceTerms,
} from '../src/core/nlp.js';
import type { TaggedSentence, TaggedTerm } from '../src/core/types.js';

function createStubNlpWithTaggedTerms(terms: Array<{ text: string; tags: Record<string, boolean> | string[] }>) {
  return (_text: string) => ({
    terms: () => ({
      json: () => terms.map((term) => ({ text: term.text, tags: term.tags })),
    }),
    verbs: () => ({ toInfinitive: () => ({ out: (_format: 'text') => '' }) }),
    nouns: () => ({ toSingular: () => ({ out: (_format: 'text') => '' }) }),
    adjectives: () => ({ conjugate: () => [] as Array<Record<string, string>> }),
  });
}

function createSentenceAwareStubNlp(
  termsBySentence: Record<string, Array<{ text: string; tags: Record<string, boolean> | string[] }>>,
) {
  return (text: string) => ({
    terms: () => ({
      json: () => (termsBySentence[text] ?? []).map((term) => ({ text: term.text, tags: term.tags })),
    }),
    verbs: () => ({ toInfinitive: () => ({ out: (_format: 'text') => '' }) }),
    nouns: () => ({ toSingular: () => ({ out: (_format: 'text') => '' }) }),
    adjectives: () => ({ conjugate: () => [] as Array<Record<string, string>> }),
  });
}

function createStubNlpWithParentTaggedNestedTerms(
  terms: Array<{ text: string; parentTags: Record<string, boolean> | string[] }>,
) {
  return (_text: string) => ({
    terms: () => ({
      json: () => terms.map((term) => ({
        text: term.text,
        tags: term.parentTags,
        terms: [{ text: term.text }],
      })),
    }),
    verbs: () => ({ toInfinitive: () => ({ out: (_format: 'text') => '' }) }),
    nouns: () => ({ toSingular: () => ({ out: (_format: 'text') => '' }) }),
    adjectives: () => ({ conjugate: () => [] as Array<Record<string, string>> }),
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
  const result = contextualDeinflectTaggedTerms(tagged, {}, lowerToIdx, new Set<string>(), true, null);

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

  const result = contextualDeinflectTaggedTerms(tagged, {}, lowerToIdx, new Set<string>(), true, null);
  assert.deepEqual(result.tokens, ['', '', '', '', 'work']);
  assert.deepEqual(result.properFlags, [true, true, true, true, false]);
});

test('heuristic capitalization stays lexicon-gated to avoid over-filtering', () => {
  const terms = [createTaggedTerm('England', true)];
  const lowerToIdx = new Map<string, number>([['england', 0]]);

  const withoutLexicon = contextualDeinflectTaggedTerms(terms, {}, lowerToIdx, new Set<string>(), true, null);
  assert.deepEqual(withoutLexicon.tokens, ['england']);
  assert.deepEqual(withoutLexicon.properFlags, [false]);

  const withLexicon = contextualDeinflectTaggedTerms(terms, {}, lowerToIdx, new Set<string>(['england']), true, null);
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

  const one = contextualDeinflectTaggedTerms(sentenceOneTerms, {}, lowerToIdx, new Set<string>(), true, null);
  const two = contextualDeinflectTaggedTerms(sentenceTwoTerms, {}, lowerToIdx, new Set<string>(), true, null);

  assert.deepEqual(one.tokens, ['the', 'professor', 'in', 'the', '', 'and', '']);
  assert.deepEqual(two.tokens, ['finally', '', '', 'finished', 'the', 'work']);

  assert.deepEqual(one.properFlags, [false, false, false, false, true, false, true]);
  assert.deepEqual(two.properFlags, [false, true, true, false, false, false]);
});

test('high-confidence lexicon matches canonical dent/monday vector', () => {
  const taggedSentences: TaggedSentence[] = [
    { text: 'Arthur Dent', terms: [
      { raw: 'Arthur', normalized: 'arthur', tags: new Set<string>(['ProperNoun']), sentenceInitial: true },
      { raw: 'Dent', normalized: 'dent', tags: new Set<string>(['ProperNoun']), sentenceInitial: false },
    ] },
    { text: 'He met Dent', terms: [
      createTaggedTerm('He', true),
      createTaggedTerm('met', false),
      { raw: 'Dent', normalized: 'dent', tags: new Set<string>(['ProperNoun']), sentenceInitial: false },
    ] },
    { text: 'Again Dent', terms: [
      createTaggedTerm('Again', true),
      { raw: 'Dent', normalized: 'dent', tags: new Set<string>(['ProperNoun']), sentenceInitial: false },
    ] },
    { text: 'Monday arrived', terms: [
      { raw: 'Monday', normalized: 'monday', tags: new Set<string>(['ProperNoun']), sentenceInitial: true },
      createTaggedTerm('arrived', false),
    ] },
    { text: 'Monday left', terms: [
      { raw: 'Monday', normalized: 'monday', tags: new Set<string>(['ProperNoun']), sentenceInitial: true },
      createTaggedTerm('left', false),
    ] },
  ];

  const lexicon = buildHighConfidenceProperNounLexicon(taggedSentences);
  assert.equal(lexicon.has('dent'), true);
  assert.equal(lexicon.has('monday'), false);
});

test('provided multi-sentence sample excludes proper names from analysis', () => {
  const sentence1 = 'The three translators are, first and foremost, the excellent translator of the first seven chapters, Fung Yu-Lan, professor of Chinese in the USA and China during most of this century.';
  const sentence2 = 'Finally, that master of translation – not necessarily for the ease of his translation but for the depth of his work – James Legge.';
  const sentence3 = 'Except in the United States of America, this book is sold subjectto the condition that it shall not, by way of trade or otherwise, be lent,re-sold, hired out, or otherwise circulated without the publisher’sprior consent in any form of binding or cover other than that inwhich it is published and without a similar condition including thiscondition being imposed on the subsequent purchaser';

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
  const result = contextualDeinflectTaggedTerms(taggedTerms, {}, lowerToIdx, properLexicon, true, null);

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
    taggedTerms: Array<{ text: string; tags: Record<string, boolean> | string[] }>;
    expectedExcluded: string[];
    expectedIncluded: string[];
  }> = [
    {
      sentence: '“Give your evidence,” said the King; “and don’t be nervous, or I’ll have you executed on the spot.',
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
      sentence: '“It wasn’t very civil of you to sit down without being invited,” said the March Hare.',
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
      sentence: '” Alice panted as she ran; but the Gryphon only answered “Come on!',
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
      sentence: '” “Call the first witness,” said the King; and the White Rabbit blew three blasts on the trumpet, and called out, “First witness!',
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
      sentence: '” The Hatter opened his eyes very wide on hearing this; but all he _said_ was, “Why is a raven like a writing-desk?',
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
      sentence: '“Well, I never heard it before,” said the Mock Turtle; “but it sounds uncommon nonsense.',
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
      sentence: 'It was the White Rabbit returning, splendidly dressed, with a pair of white kid gloves in one hand and a large fan in the other: he came trotting along in a great hurry, muttering to himself as he came, “Oh!',
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
      sentence: '“Stand up and repeat ‘’_Tis the voice of the sluggard_,’” said the Gryphon.',
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
      sentence: 'The Cat’s head began fading away the moment he was gone, and, by the time he had come back with the Duchess, it had entirely disappeared; so the King and the executioner ran wildly up and down looking for it, while the rest of the party went back to the game.',
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
      sentence: '” said the Queen, “and take this young lady to see the Mock Turtle, and to hear his history.',
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
    const lowerToIdx = new Map<string, number>(tagged.map((term, index) => [term.normalized, index]));
    const result = contextualDeinflectTaggedTerms(tagged, {}, lowerToIdx, new Set<string>(), true, null);

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
      assert.equal(excluded.has(expected), true, `Expected '${expected}' to be excluded in sentence: ${sample.sentence}`);
    }
    for (const expected of sample.expectedIncluded) {
      assert.equal(included.has(expected), true, `Expected '${expected}' to remain included in sentence: ${sample.sentence}`);
    }
  }
});

test('ten Hitchhikers sentences exclude proper nouns reliably', () => {
  const cases: Array<{
    sentence: string;
    taggedTerms: Array<{ text: string; tags: Record<string, boolean> | string[] }>;
    expectedExcluded: string[];
    expectedIncluded: string[];
  }> = [
    {
      sentence: '“But unfortunately,” continued Ford, “it rather involved being on the other side of this airtight hatchway.',
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
      sentence: 'In The Hitchhiker’s Guide to the Galaxy, there’s a passage about the Vl’hurgs and their commander being “resplendent in his black jewelled battle shorts.',
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
      sentence: '“Yes, an electronic brain,” said Frankie, “a simple one would suffice.',
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
      sentence: 'I mean, here we are on the run and everything, we must have the police of half the Galaxy after us by now, and we stop to pick up hitchhikers.',
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
      sentence: '“It could always be replaced,” said Benjy reasonably, “if you think it’s important.',
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
      sentence: '” “That is but the first half of the story, Earthman,” said the old man.',
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
      sentence: '“Listen,” said Ford, who was still engrossed in the sales brochure, “they make a big thing of the ship’s cybernetics.',
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
      sentence: '” said the Queen, “and take this young lady to see the Mock Turtle, and to hear his history.',
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
      sentence: '“Well,” said Zaphod, attacking a boneful of grilled muscle, “our guests here have been gassing us and zapping our minds and being generally weird and have now given us a rather nice meal to make it up to us.',
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
      sentence: '“There must be some mistake,” he said, “are you not a greater computer than the Milliard Gargantubrain at Maximegalon which can count all the atoms in a star in a millisecond?',
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
    const lowerToIdx = new Map<string, number>(tagged.map((term, index) => [term.normalized, index]));
    const result = contextualDeinflectTaggedTerms(tagged, {}, lowerToIdx, new Set<string>(), true, null);

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
      assert.equal(excluded.has(expected), true, `Expected '${expected}' to be excluded in sentence: ${sample.sentence}`);
    }
    for (const expected of sample.expectedIncluded) {
      assert.equal(included.has(expected), true, `Expected '${expected}' to remain included in sentence: ${sample.sentence}`);
    }
  }
});
