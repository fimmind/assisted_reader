export const LEXICON_SCHEMA_VERSION = 2;

export const WIKTEXTRACT_POS_MAP = new Map([
  ['noun', 'noun'],
  ['name', 'proper-noun'],
  ['proper_noun', 'proper-noun'],
  ['verb', 'verb'],
  ['adj', 'adjective'],
  ['adj_noun', 'adjective'],
  ['adj_verb', 'adjective'],
  ['adv', 'adverb'],
  ['pron', 'pronoun'],
  ['det', 'determiner'],
  ['article', 'article'],
  ['prep', 'preposition'],
  ['prep_phrase', 'preposition'],
  ['postp', 'postposition'],
  ['conj', 'conjunction'],
  ['intj', 'interjection'],
  ['num', 'numeral'],
  ['particle', 'particle'],
  ['classifier', 'classifier'],
  ['phrase', 'phrase'],
  ['proverb', 'phrase'],
  ['abbrev', 'abbreviation'],
  ['contraction', 'contraction'],
  ['prefix', 'prefix'],
  ['infix', 'infix'],
  ['suffix', 'suffix'],
  ['symbol', 'symbol'],
  ['character', 'symbol'],
  ['punct', 'symbol'],
]);

export const CANONICAL_PARTS_OF_SPEECH = new Set([
  ...WIKTEXTRACT_POS_MAP.values(),
  'other',
]);
