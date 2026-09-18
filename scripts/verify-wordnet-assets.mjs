import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LEXICON_BUCKET_ALGORITHM,
  LEXICON_BUCKET_COUNT,
  hashLexiconWord,
  resolveLexiconBucketFileName,
} from './lexicon-schema.mjs';

/** Validate the complete shipped database before copying it or publishing it. */
export async function verifyWordNetAssets(directory) {
  const indexPath = path.join(directory, 'index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  if (
    !index || typeof index !== 'object'
    || index.schemaVersion !== 1 || index.wordnetVersion !== '3.0'
    || index.bucketAlgorithm !== LEXICON_BUCKET_ALGORITHM
    || index.bucketCount !== LEXICON_BUCKET_COUNT
    || !Number.isInteger(index.entryCount) || index.entryCount <= 0
    || typeof index.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(index.sourceSha256)
  ) {
    throw new Error(`Invalid WordNet index: file=${indexPath}`);
  }
  const license = await readFile(path.join(directory, 'LICENSE'), 'utf8');
  if (!license.replace(/\s+/g, ' ').includes('WordNet 3.0 Copyright 2006 by Princeton University. All rights reserved.')) {
    throw new Error(`Missing WordNet copyright notice: directory=${directory}`);
  }
  let entryCount = 0;
  for (let bucketId = 0; bucketId < LEXICON_BUCKET_COUNT; bucketId += 1) {
    const chunkPath = path.join(directory, resolveLexiconBucketFileName(bucketId));
    const entries = JSON.parse(await readFile(chunkPath, 'utf8'));
    if (!Array.isArray(entries)) {
      throw new Error(`Invalid WordNet bucket: file=${chunkPath}`);
    }
    const words = new Set();
    for (const entry of entries) {
      if (
        !entry || typeof entry.word !== 'string'
        || !/^[a-z]+(?:'[a-z]+)?(?:-[a-z]+(?:'[a-z]+)?)*$/.test(entry.word)
        || !Array.isArray(entry.senses) || entry.senses.length === 0
      ) {
        throw new Error(`Invalid WordNet entry: file=${chunkPath}`);
      }
      if (words.has(entry.word)) {
        throw new Error(`Duplicate WordNet entry: word=${entry.word} file=${chunkPath}`);
      }
      words.add(entry.word);
      if (hashLexiconWord(entry.word) % LEXICON_BUCKET_COUNT !== bucketId) {
        throw new Error(`WordNet word is in the wrong bucket: word=${entry.word} file=${chunkPath}`);
      }
      const partsOfSpeech = new Set();
      for (const sense of entry.senses) {
        if (
          !sense || !['noun', 'verb', 'adjective', 'adverb'].includes(sense.partOfSpeech)
          || !Array.isArray(sense.definitions) || sense.definitions.length === 0
        ) {
          throw new Error(`Invalid WordNet sense group: word=${entry.word} file=${chunkPath}`);
        }
        if (partsOfSpeech.has(sense.partOfSpeech)) {
          throw new Error(`Duplicate WordNet POS group: word=${entry.word} pos=${sense.partOfSpeech}`);
        }
        partsOfSpeech.add(sense.partOfSpeech);
        const ids = new Set();
        for (const definition of sense.definitions) {
          if (
            !definition || typeof definition.id !== 'string' || definition.id.trim().length === 0
            || typeof definition.gloss !== 'string' || definition.gloss.trim().length === 0
          ) {
            throw new Error(`Invalid WordNet definition: word=${entry.word} file=${chunkPath}`);
          }
          if (ids.has(definition.id)) {
            throw new Error(`Duplicate WordNet synset: word=${entry.word} id=${definition.id}`);
          }
          ids.add(definition.id);
        }
      }
      entryCount += 1;
    }
  }
  if (entryCount !== index.entryCount) {
    throw new Error(`WordNet entry count mismatch: expected=${index.entryCount} actual=${entryCount}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory) {
    throw new Error('Provide the WordNet asset directory to validate.');
  }
  await verifyWordNetAssets(path.resolve(directory));
  console.log('wordnet-assets-verified', { directory });
}
