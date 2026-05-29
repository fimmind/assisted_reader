import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const DIST_DIR = path.resolve(process.cwd(), 'dist');
const requiredFiles = [
  'index.html',
  'data/best_grouped_irt_model_model_data.json',
  'data/lemma_dict.json',
  'data/hitchhikers_guide.txt',
  'data/lexicon_full.json',
  'data/lexicon/index.json',
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
  const chunkNames = Object.values(payload);
  if (chunkNames.length === 0) {
    throw new Error('Lexicon index has no chunk entries.');
  }
  for (const chunkName of chunkNames) {
    if (typeof chunkName !== 'string' || chunkName.length === 0) {
      throw new Error('Lexicon index contains an invalid chunk name.');
    }
    await assertFileExists(`data/lexicon/${chunkName}`);
  }
}

async function verifyLexiconFull() {
  const fullPath = path.join(DIST_DIR, 'data/lexicon_full.json');
  const raw = await readFile(fullPath, 'utf8');
  const payload = JSON.parse(raw);
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error('Invalid lexicon payload in dist/data/lexicon_full.json');
  }

  const sampleSize = Math.min(payload.length, 50);
  for (let index = 0; index < sampleSize; index += 1) {
    const entry = payload[index];
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Invalid lexicon entry at index=${index} in dist/data/lexicon_full.json`);
    }
    if (typeof entry.word !== 'string' || entry.word.trim().length === 0) {
      throw new Error(`Invalid lexicon word at index=${index} in dist/data/lexicon_full.json`);
    }

    const hasDefinition = typeof entry.definition === 'string' && entry.definition.trim().length > 0;
    const hasDefinitionsArray = Array.isArray(entry.definitions)
      && entry.definitions.some((value) => typeof value === 'string' && value.trim().length > 0);
    if (!hasDefinition && !hasDefinitionsArray) {
      throw new Error(`Missing definition content at index=${index} in dist/data/lexicon_full.json`);
    }
  }
}

async function main() {
  for (const file of requiredFiles) {
    await assertFileExists(file);
  }
  await verifyLexiconFull();
  await verifyLexiconChunks();
  console.log('Deploy asset verification passed.');
}

await main();
