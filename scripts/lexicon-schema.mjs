export const LEXICON_SCHEMA_VERSION = 4;
export const LEXICON_BUCKET_ALGORITHM = 'fnv1a-32';
export const LEXICON_BUCKET_COUNT = 1024;

export function hashLexiconWord(word) {
  let hash = 2166136261;
  for (let index = 0; index < word.length; index += 1) {
    hash ^= word.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

export function resolveLexiconBucketFileName(bucketId) {
  return `${String(bucketId).padStart(4, '0')}.json`;
}

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
