import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const DIST_DIR = path.resolve(process.cwd(), 'dist');
const requiredFiles = [
  'index.html',
  'data/words.csv',
  'data/lemma_dict.json',
  'data/hitchhikers_guide.txt',
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

  let sampledEntryCount = 0;
  const sampleLimit = 50;
  for (const chunkName of chunkNames) {
    if (typeof chunkName !== 'string' || chunkName.length === 0) {
      throw new Error('Lexicon index contains an invalid chunk name.');
    }
    const relativePath = `data/lexicon/${chunkName}`;
    await assertFileExists(relativePath);

    if (sampledEntryCount >= sampleLimit) {
      continue;
    }

    const chunkPath = path.join(DIST_DIR, relativePath);
    const chunkRaw = await readFile(chunkPath, 'utf8');
    const chunkPayload = JSON.parse(chunkRaw);
    if (!Array.isArray(chunkPayload)) {
      throw new Error(`Invalid lexicon chunk payload in ${relativePath}`);
    }

    for (const entry of chunkPayload) {
      if (sampledEntryCount >= sampleLimit) {
        break;
      }
      if (!entry || typeof entry !== 'object') {
        throw new Error(`Invalid lexicon entry in ${relativePath}`);
      }
      if (typeof entry.word !== 'string' || entry.word.trim().length === 0) {
        throw new Error(`Invalid lexicon word in ${relativePath}`);
      }
      const hasDefinition = typeof entry.definition === 'string' && entry.definition.trim().length > 0;
      const hasDefinitionsArray = Array.isArray(entry.definitions)
        && entry.definitions.some((value) => typeof value === 'string' && value.trim().length > 0);
      if (!hasDefinition && !hasDefinitionsArray) {
        throw new Error(`Missing definition content in ${relativePath}`);
      }
      sampledEntryCount += 1;
    }
  }

  if (sampledEntryCount === 0) {
    throw new Error('Lexicon chunks contain no entries.');
  }
}

async function main() {
  for (const file of requiredFiles) {
    await assertFileExists(file);
  }
  await verifyLexiconChunks();
  console.log('Deploy asset verification passed.');
}

await main();
