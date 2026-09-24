import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
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
  'wsd/ettin-150m-wsd/manifest.json',
  'wsd/ettin-150m-wsd/LICENSE',
  'wsd/ettin-150m-wsd/NOTICE.txt',
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

async function hashFile(filePath) {
  const digest = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
    size += chunk.length;
  }
  return { sha256: digest.digest('hex'), size };
}

async function verifyWsdAssets() {
  const relativeRoot = 'wsd/ettin-150m-wsd';
  const sourceRoot = path.resolve('public', relativeRoot);
  const deployedRoot = path.join(DIST_DIR, relativeRoot);
  const [sourceManifest, deployedManifest] = await Promise.all([
    readFile(path.join(sourceRoot, 'manifest.json')),
    readFile(path.join(deployedRoot, 'manifest.json')),
  ]);
  if (!sourceManifest.equals(deployedManifest)) {
    throw new Error('Deployed WSD manifest differs from source.');
  }
  const manifest = JSON.parse(deployedManifest.toString('utf8'));
  if (manifest.revision !== '8751b577199d1bb95b74fa2457da7065d57100ae'
    || !Number.isSafeInteger(manifest.size) || manifest.size <= 0
    || !Array.isArray(manifest.parts) || manifest.parts.length === 0 || manifest.parts.length > 20
    || !manifest.metadata || typeof manifest.metadata !== 'object') {
    throw new Error('Invalid deployed WSD manifest.');
  }
  for (const [index, part] of manifest.parts.entries()) {
    if (!part || part.name !== `model.part${String(index).padStart(2, '0')}`
      || !Number.isSafeInteger(part.size) || part.size <= 0) {
      throw new Error(`Invalid WSD model part declaration: index=${index}`);
    }
  }
  const assets = [
    ...manifest.parts.map((part) => ({ name: part.name, sha256: part.sha256, size: part.size })),
    ...['tokenizer.json', 'tokenizer_config.json', 'answer_letters.json'].map((name) => ({
      name, sha256: manifest.metadata[name], size: null,
    })),
    ...['LICENSE', 'NOTICE.txt'].map((name) => ({ name, sha256: null, size: null })),
  ];
  let totalModelBytes = 0;
  for (const asset of assets) {
    if (typeof asset.name !== 'string' || !/^(model\.part\d{2}|tokenizer\.json|tokenizer_config\.json|answer_letters\.json|LICENSE|NOTICE\.txt)$/.test(asset.name)
      || (asset.sha256 !== null && (typeof asset.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(asset.sha256)))) {
      throw new Error(`Invalid WSD asset declaration: name=${String(asset.name)}`);
    }
    const [source, deployed] = await Promise.all([
      hashFile(path.join(sourceRoot, asset.name)),
      hashFile(path.join(deployedRoot, asset.name)),
    ]);
    if (source.sha256 !== deployed.sha256 || source.size !== deployed.size
      || (asset.sha256 !== null && deployed.sha256 !== asset.sha256)
      || (asset.size !== null && deployed.size !== asset.size)) {
      throw new Error(`Invalid deployed WSD asset: name=${asset.name}`);
    }
    if (asset.name.startsWith('model.part')) {
      totalModelBytes += deployed.size;
    }
  }
  if (totalModelBytes !== manifest.size) {
    throw new Error(`Invalid deployed WSD model size: expected=${manifest.size} actual=${totalModelBytes}`);
  }
  const wasmFiles = (await readdir(path.join(DIST_DIR, 'assets')))
    .filter((name) => /^ort-wasm-simd-threaded-[\w-]+\.wasm$/.test(name));
  if (wasmFiles.length !== 1) {
    throw new Error(`Expected one deployed WSD runtime binary: found=${wasmFiles.length}`);
  }
  const [installedWasm, deployedWasm] = await Promise.all([
    hashFile(path.resolve('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm')),
    hashFile(path.join(DIST_DIR, 'assets', wasmFiles[0])),
  ]);
  if (installedWasm.sha256 !== deployedWasm.sha256) {
    throw new Error('Deployed WSD runtime binary differs from installed ONNX Runtime.');
  }
  const workers = (await readdir(path.join(DIST_DIR, 'assets')))
    .filter((name) => /^ettin-wsd\.worker-[\w-]+\.js$/.test(name));
  if (workers.length !== 1) {
    throw new Error(`Expected one deployed WSD worker: found=${workers.length}`);
  }
  const worker = await readFile(path.join(DIST_DIR, 'assets', workers[0]), 'utf8');
  if (!worker.includes('wsd/ettin-150m-wsd/') || !worker.includes(wasmFiles[0])) {
    throw new Error('Deployed WSD worker does not reference the model and runtime assets.');
  }
}

async function main() {
  for (const file of requiredFiles) {
    await assertFileExists(file);
  }
  await verifyLexiconChunks();
  await verifyWordNetAssets(path.join(DIST_DIR, 'data/wordnet'));
  await verifyDictionaryCopies();
  await verifyWsdAssets();
  console.log('Deploy asset verification passed.');
}

await main();
