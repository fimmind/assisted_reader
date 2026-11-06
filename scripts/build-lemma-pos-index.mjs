import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  LEXICON_BUCKET_COUNT,
  resolveLexiconBucketFileName,
} from './lexicon-schema.mjs';

const ROOT = process.cwd();
const LEXICON_DIR = path.join(ROOT, 'data', 'lexicon');
const VOCABULARY_PATH = path.join(ROOT, 'data', 'words.csv');
const LEMMA_DICT_PATH = path.join(ROOT, 'data', 'lemma_dict.json');
const OUTPUT_PATH = path.join(LEXICON_DIR, 'inflection-index.json');
const INDEX_SCHEMA_VERSION = 1;

const POSITIONS = [
  'noun', 'proper-noun', 'verb', 'adjective', 'adverb', 'pronoun',
  'determiner', 'article', 'preposition', 'postposition', 'conjunction',
  'interjection', 'numeral', 'particle', 'classifier', 'phrase',
  'abbreviation', 'contraction', 'prefix', 'infix', 'suffix', 'symbol', 'other',
];
const POS_BITS = new Map(POSITIONS.map((part, index) => [part, 2 ** index]));

function normalizeWord(value) {
  return value.trim().toLowerCase();
}

function parseVocabulary(raw) {
  const lines = raw.split(/\r?\n/u);
  const wordColumn = lines[0]?.split(',').indexOf('word') ?? -1;
  if (wordColumn < 0) {
    throw new Error('Vocabulary CSV is missing the word column.');
  }
  return new Set(lines.slice(1).map((line) => {
    const columns = line.split(',');
    return normalizeWord(columns[wordColumn] ?? '');
  }).filter((word) => word.length > 0));
}

function recognizeInflection(definition, partOfSpeech) {
  const patterns = [
    /^(?:plural|plural form) of ([a-z][a-z'-]*)\.?$/iu,
    /^(?:simple past and past participle|past and past participle|simple past|past tense|past participle) of ([a-z][a-z'-]*)\.?$/iu,
    /^(?:present participle and gerund|present participle|gerund) of ([a-z][a-z'-]*)\.?$/iu,
    /^third-person singular simple present(?: indicative)? of ([a-z][a-z'-]*)\.?$/iu,
    /^(?:comparative|superlative) degree of ([a-z][a-z'-]*)(?: and [a-z][a-z'-]*)?\.?$/iu,
    /^(?:comparative|superlative) form of ([a-z][a-z'-]*)(?:\s*:\s*.*)?\.?$/iu,
  ];
  if (!['noun', 'verb', 'adjective'].includes(partOfSpeech)) {
    return null;
  }
  for (const pattern of patterns) {
    const match = definition.trim().match(pattern);
    if (match) {
      return normalizeWord(match[1]);
    }
  }
  return null;
}

function setMask(target, word, mask) {
  target.set(word, (target.get(word) ?? 0) | mask);
}

async function main() {
  const vocabulary = parseVocabulary(await readFile(VOCABULARY_PATH, 'utf8'));
  const lemmaDictionary = JSON.parse(await readFile(LEMMA_DICT_PATH, 'utf8'));
  const targetMasks = new Map();
  const records = new Map();

  for (let bucketId = 0; bucketId < LEXICON_BUCKET_COUNT; bucketId += 1) {
    const bucketPath = path.join(LEXICON_DIR, resolveLexiconBucketFileName(bucketId));
    const entries = JSON.parse(await readFile(bucketPath, 'utf8'));
    for (const entry of entries) {
      const word = normalizeWord(entry.word);
      let wordMask = 0;
      for (const sense of entry.senses) {
        wordMask |= POS_BITS.get(sense.partOfSpeech) ?? 0;
      }
      if (vocabulary.has(word)) {
        targetMasks.set(word, wordMask);
      }
      const relations = new Map();
      for (const sense of entry.senses) {
        const partMask = POS_BITS.get(sense.partOfSpeech) ?? 0;
        for (const definition of sense.definitions) {
          const lemma = recognizeInflection(definition, sense.partOfSpeech);
          if (lemma && vocabulary.has(lemma)) {
            setMask(relations, lemma, partMask);
          }
        }
      }
      if (vocabulary.has(word) || relations.size > 0) {
        records.set(word, {
          word,
          pos: wordMask,
          lemmas: relations,
        });
      }
    }
  }

  for (const [source, targetValue] of Object.entries(lemmaDictionary)) {
    const word = normalizeWord(source);
    const lemma = normalizeWord(targetValue);
    if (!vocabulary.has(lemma)) {
      continue;
    }
    const targetMask = targetMasks.get(lemma) ?? 0;
    if (targetMask > 0) {
      const record = records.get(word) ?? { word, pos: 0, lemmas: new Map() };
      if (!record.lemmas.has(lemma)) {
        const sourceMask = record.pos;
        const sharedMask = sourceMask & targetMask;
        if (sharedMask > 0) {
          setMask(record.lemmas, lemma, sharedMask);
        }
      }
      if (record.pos > 0 || record.lemmas.size > 0) {
        records.set(word, record);
      }
    }
  }

  const output = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    positions: POSITIONS,
    entries: Object.fromEntries([...records.values()].map(({ word, pos, lemmas }) => [
      word,
      { pos, lemmas: Object.fromEntries(lemmas) },
    ])),
  };
  await writeFile(OUTPUT_PATH, `${JSON.stringify(output)}\n`);
  console.log('lemma-pos-index-written', { entries: records.size, path: OUTPUT_PATH });
}

try {
  await main();
} catch (error) {
  console.error('build-lemma-pos-index-failed', { error: String(error) });
  process.exitCode = 1;
}
