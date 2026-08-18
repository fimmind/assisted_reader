#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  LEXICON_BUCKET_ALGORITHM,
  LEXICON_BUCKET_COUNT,
  LEXICON_SCHEMA_VERSION,
  resolveLexiconBucketFileName,
} from './lexicon-schema.mjs';

const ROOT_DIR = process.cwd();
const LEXICON_DIR = path.join(ROOT_DIR, 'data', 'lexicon');
const LEXICON_INDEX_PATH = path.join(LEXICON_DIR, 'index.json');

function hasValidLexiconArtifacts() {
  if (!fs.existsSync(LEXICON_INDEX_PATH)) {
    return false;
  }

  let indexPayload;
  try {
    indexPayload = JSON.parse(fs.readFileSync(LEXICON_INDEX_PATH, 'utf8'));
  } catch (_error) {
    return false;
  }

  if (
    !indexPayload
    || typeof indexPayload !== 'object'
    || indexPayload.schemaVersion !== LEXICON_SCHEMA_VERSION
    || indexPayload.bucketAlgorithm !== LEXICON_BUCKET_ALGORITHM
    || indexPayload.bucketCount !== LEXICON_BUCKET_COUNT
  ) {
    return false;
  }

  for (let bucketId = 0; bucketId < LEXICON_BUCKET_COUNT; bucketId += 1) {
    const chunkName = resolveLexiconBucketFileName(bucketId);
    const chunkPath = path.join(LEXICON_DIR, chunkName);
    if (!fs.existsSync(chunkPath)) {
      return false;
    }
  }

  return true;
}

function runLexiconBuild() {
  const result = spawnSync('node', ['scripts/build-lexicon-from-wiktextract.mjs'], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    const status = typeof result.status === 'number' ? result.status : -1;
    throw new Error(`Failed to generate lexicon artifacts: exitCode=${status}`);
  }
}

function main() {
  if (hasValidLexiconArtifacts()) {
    console.log('lexicon-artifacts-ready', { indexPath: LEXICON_INDEX_PATH });
    return;
  }

  console.log('lexicon-artifacts-missing-or-invalid', { indexPath: LEXICON_INDEX_PATH });
  runLexiconBuild();
}

try {
  main();
} catch (error) {
  console.error('ensure-lexicon-generated-failed', { error: String(error) });
  process.exitCode = 1;
}
