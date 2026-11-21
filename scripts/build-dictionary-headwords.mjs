import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const OUTPUT_PATH = path.join(DATA_DIR, 'lexicon', 'headwords.json');
const BUCKET_PATTERN = /^\d{4}\.json$/u;

function hasUsableDefinition(sense) {
  if (!sense || typeof sense !== 'object' || !Array.isArray(sense.definitions)) {
    return false;
  }
  return sense.definitions.some((definition) => {
    if (typeof definition === 'string') {
      return definition.trim().length > 0;
    }
    return definition !== null && typeof definition === 'object'
      && typeof definition.gloss === 'string' && definition.gloss.trim().length > 0;
  });
}

function collectHeadwords(dictionaryDirectory) {
  const headwords = new Set();
  const bucketNames = readdirSync(dictionaryDirectory).filter((name) => BUCKET_PATTERN.test(name)).sort();
  if (bucketNames.length === 0) {
    throw new Error(`No dictionary buckets found: directory=${dictionaryDirectory}`);
  }
  for (const bucketName of bucketNames) {
    const bucketPath = path.join(dictionaryDirectory, bucketName);
    const entries = JSON.parse(readFileSync(bucketPath, 'utf8'));
    if (!Array.isArray(entries)) {
      throw new Error(`Invalid dictionary bucket payload: path=${bucketPath}`);
    }
    for (const entry of entries) {
      if (typeof entry?.word !== 'string' || entry.word.trim().length === 0) {
        continue;
      }
      if (Array.isArray(entry.senses) && entry.senses.some(hasUsableDefinition)) {
        headwords.add(entry.word);
      }
    }
  }
  return headwords;
}

const headwords = [...collectHeadwords(path.join(DATA_DIR, 'lexicon')),
  ...collectHeadwords(path.join(DATA_DIR, 'wordnet'))];
const sortedUniqueHeadwords = [...new Set(headwords)].sort();
writeFileSync(OUTPUT_PATH, `${JSON.stringify(sortedUniqueHeadwords)}\n`);
console.log(`Built dictionary headwords: count=${sortedUniqueHeadwords.length} path=${OUTPUT_PATH}`);
