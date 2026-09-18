import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyWordNetAssets } from './verify-wordnet-assets.mjs';
import {
  CANONICAL_PARTS_OF_SPEECH,
  LEXICON_BUCKET_ALGORITHM,
  LEXICON_BUCKET_COUNT,
  LEXICON_SCHEMA_VERSION,
  hashLexiconWord,
  resolveLexiconBucketFileName,
} from './lexicon-schema.mjs';

const DIST_DIR = path.resolve(process.cwd(), 'dist');
const requiredFiles = [
  'index.html',
  'data/words.csv',
  'data/lemma_dict.json',
  'data/hitchhikers_guide.txt',
  'data/lexicon/index.json',
  'data/wordnet/index.json',
  'data/wordnet/LICENSE',
];

async function assertFileExists(relativePath) {
  const absolutePath = path.join(DIST_DIR, relativePath);
  try {
    await access(absolutePath);
  } catch {
    throw new Error(`Missing required deploy asset: ${relativePath}`);
  }
}

async function verifyLexiconChunks() {
  const indexPath = path.join(DIST_DIR, 'data/lexicon/index.json');
  const raw = await readFile(indexPath, 'utf8');
  const payload = JSON.parse(raw);
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid lexicon index payload in dist/data/lexicon/index.json');
  }
  if (payload.schemaVersion !== LEXICON_SCHEMA_VERSION) {
    throw new Error(
      `Invalid lexicon schema version: expected=${LEXICON_SCHEMA_VERSION} actual=${String(payload.schemaVersion)}`,
    );
  }
  if (payload.bucketAlgorithm !== LEXICON_BUCKET_ALGORITHM) {
    throw new Error(`Invalid lexicon bucket algorithm: ${String(payload.bucketAlgorithm)}`);
  }
  if (payload.bucketCount !== LEXICON_BUCKET_COUNT) {
    throw new Error(`Invalid lexicon bucket count: ${String(payload.bucketCount)}`);
  }

  let entryCount = 0;
  for (let bucketId = 0; bucketId < LEXICON_BUCKET_COUNT; bucketId += 1) {
    const chunkName = resolveLexiconBucketFileName(bucketId);
    const relativePath = `data/lexicon/${chunkName}`;
    await assertFileExists(relativePath);

    const chunkPath = path.join(DIST_DIR, relativePath);
    const chunkRaw = await readFile(chunkPath, 'utf8');
    const chunkPayload = JSON.parse(chunkRaw);
    if (!Array.isArray(chunkPayload)) {
      throw new Error(`Invalid lexicon chunk payload in ${relativePath}`);
    }

    for (const entry of chunkPayload) {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`Invalid lexicon entry in ${relativePath}`);
      }
      if (typeof entry.word !== 'string' || entry.word.trim().length === 0) {
        throw new Error(`Invalid lexicon word in ${relativePath}`);
      }
      const expectedBucketId = hashLexiconWord(entry.word) % LEXICON_BUCKET_COUNT;
      if (expectedBucketId !== bucketId) {
        throw new Error(
          `Lexicon word is in the wrong bucket: word=${entry.word} expected=${expectedBucketId} actual=${bucketId}`,
        );
      }
      if (!Array.isArray(entry.senses)) {
        throw new Error(`Missing lexicon senses in ${relativePath}`);
      }
      const seenPartsOfSpeech = new Set();
      for (const sense of entry.senses) {
        if (!sense || typeof sense !== 'object') {
          throw new Error(`Invalid lexicon sense in ${relativePath}`);
        }
        if (!CANONICAL_PARTS_OF_SPEECH.has(sense.partOfSpeech)) {
          throw new Error(`Invalid part of speech in ${relativePath}: ${String(sense.partOfSpeech)}`);
        }
        if (seenPartsOfSpeech.has(sense.partOfSpeech)) {
          throw new Error(`Duplicate part of speech for word=${entry.word} in ${relativePath}`);
        }
        seenPartsOfSpeech.add(sense.partOfSpeech);
        const hasDefinitions = Array.isArray(sense.definitions)
          && sense.definitions.length > 0
          && sense.definitions.every((value) => typeof value === 'string' && value.trim().length > 0);
        if (!hasDefinitions) {
          throw new Error(`Missing POS-specific definition content in ${relativePath}`);
        }
      }
      entryCount += 1;
    }
  }

  if (entryCount === 0) {
    throw new Error('Lexicon chunks contain no entries.');
  }
  if (entryCount !== payload.entryCount) {
    throw new Error(`Lexicon entry count mismatch: expected=${String(payload.entryCount)} actual=${entryCount}`);
  }
}

async function verifyDictionaryCopies() {
  for (const source of ['lexicon', 'wordnet']) {
    const files = [
      'index.json',
      ...Array.from({ length: LEXICON_BUCKET_COUNT }, (_, bucketId) => resolveLexiconBucketFileName(bucketId)),
      ...(source === 'wordnet' ? ['LICENSE'] : []),
    ];
    for (const file of files) {
      const relativePath = `data/${source}/${file}`;
      const [original, deployed] = await Promise.all([
        readFile(path.resolve(relativePath)),
        readFile(path.join(DIST_DIR, relativePath)),
      ]);
      if (!original.equals(deployed)) {
        throw new Error(`Deployed dictionary differs from source: file=${relativePath}`);
      }
    }
  }
}

async function main() {
  for (const file of requiredFiles) {
    await assertFileExists(file);
  }
  await verifyLexiconChunks();
  await verifyWordNetAssets(path.join(DIST_DIR, 'data/wordnet'));
  await verifyDictionaryCopies();
  console.log('Deploy asset verification passed.');
}

await main();
