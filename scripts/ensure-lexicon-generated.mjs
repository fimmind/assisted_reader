#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT_DIR = process.cwd();
const LEXICON_DIR = path.join(ROOT_DIR, 'data', 'lexicon');
const LEXICON_INDEX_PATH = path.join(LEXICON_DIR, 'index.json');

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

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

  if (!indexPayload || typeof indexPayload !== 'object') {
    return false;
  }

  const chunkNames = Object.values(indexPayload);
  if (chunkNames.length === 0) {
    return false;
  }

  for (const chunkName of chunkNames) {
    if (!isNonEmptyString(chunkName)) {
      return false;
    }
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
