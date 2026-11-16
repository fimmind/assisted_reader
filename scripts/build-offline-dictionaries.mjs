import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync, constants as zlibConstants } from 'node:zlib';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const BUCKET_COUNT = 1024;
const GZIP_LEVEL = 9;
const manifestFileName = 'manifest.json';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourcePaths(sourceDirectory) {
  const buckets = [];
  for (const dictionary of ['lexicon', 'wordnet']) {
    const names = readdirSync(path.join(sourceDirectory, dictionary))
      .filter((name) => /^\d{4}\.json$/.test(name))
      .sort();
    if (names.length !== BUCKET_COUNT) {
      throw new Error(`Expected ${BUCKET_COUNT} ${dictionary} buckets: found=${names.length}`);
    }
    for (let bucketId = 0; bucketId < BUCKET_COUNT; bucketId += 1) {
      const expectedName = `${String(bucketId).padStart(4, '0')}.json`;
      if (names[bucketId] !== expectedName) {
        throw new Error(`Missing ${dictionary} bucket: expected=${expectedName} actual=${String(names[bucketId])}`);
      }
      buckets.push(`${dictionary}/${expectedName}`);
    }
  }
  return [
    ...buckets.filter((file) => file.startsWith('lexicon/')),
    'lexicon/index.json',
    'lexicon/inflection-index.json',
    ...buckets.filter((file) => file.startsWith('wordnet/')),
    'wordnet/index.json',
    'lemma_dict.json',
    'wordnet/LICENSE',
  ];
}

function descriptorForSource(sourceDirectory, relativeSourcePath) {
  const sourceBytes = readFileSync(path.join(sourceDirectory, relativeSourcePath));
  const compressedBytes = gzipSync(sourceBytes, { level: GZIP_LEVEL, mtime: 0 });
  return {
    compressedBytes,
    descriptor: {
      path: `data/${relativeSourcePath}`,
      asset: `data/offline-dictionaries/${relativeSourcePath === 'wordnet/LICENSE'
        ? 'wordnet/LICENSE.bin' : `${relativeSourcePath}.bin`}`,
      compressedBytes: compressedBytes.length,
      uncompressedBytes: sourceBytes.length,
      sha256: sha256(compressedBytes),
    },
  };
}

function manifestFor(files) {
  const canonicalDescriptors = JSON.stringify(files);
  return {
    schemaVersion: 1,
    version: sha256(Buffer.from(canonicalDescriptors, 'utf8')),
    totalBytes: files.reduce((total, file) => total + file.compressedBytes, 0),
    files,
  };
}

export function buildOfflineDictionaries(sourceDirectory, destinationDirectory) {
  const sourceFiles = sourcePaths(sourceDirectory);
  const parentDirectory = path.dirname(destinationDirectory);
  const temporaryDirectory = `${destinationDirectory}.tmp`;
  const backupDirectory = `${destinationDirectory}.old`;
  rmSync(temporaryDirectory, { recursive: true, force: true });
  rmSync(backupDirectory, { recursive: true, force: true });
  mkdirSync(temporaryDirectory, { recursive: true });
  const files = [];
  for (const relativeSourcePath of sourceFiles) {
    const { compressedBytes, descriptor } = descriptorForSource(sourceDirectory, relativeSourcePath);
    const relativePath = path.relative('data/offline-dictionaries', descriptor.asset);
    const outputPath = path.join(temporaryDirectory, relativePath);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, compressedBytes);
    files.push(descriptor);
  }
  const manifest = manifestFor(files);
  writeFileSync(path.join(temporaryDirectory, manifestFileName), `${JSON.stringify(manifest, null, 2)}\n`);
  mkdirSync(parentDirectory, { recursive: true });
  if (pathExists(destinationDirectory)) {
    renameSync(destinationDirectory, backupDirectory);
  }
  try {
    renameSync(temporaryDirectory, destinationDirectory);
  } catch (error) {
    if (pathExists(backupDirectory)) renameSync(backupDirectory, destinationDirectory);
    throw error;
  }
  rmSync(backupDirectory, { recursive: true, force: true });
  return manifest;
}

function pathExists(filePath) {
  try {
    readdirSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOTDIR') return true;
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function listedAssetPaths(directory) {
  const paths = [];
  function visit(currentDirectory, relativeDirectory) {
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(path.join(currentDirectory, entry.name), relativePath);
      } else if (entry.isFile() && relativePath === manifestFileName) {
        continue;
      } else if (entry.isFile()) {
        paths.push(`data/offline-dictionaries/${relativePath}`);
      } else {
        throw new Error(`Unexpected offline dictionary asset entry: ${relativePath}`);
      }
    }
  }
  visit(directory, '');
  return paths.sort();
}

export function verifyOfflineDictionaryAssets(assetDirectory, sourceDirectory) {
  const manifestPath = path.join(assetDirectory, manifestFileName);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || typeof manifest.version !== 'string'
    || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Invalid offline dictionary manifest.');
  }
  const expectedSources = sourcePaths(sourceDirectory).map((relativePath) => `data/${relativePath}`);
  const actualSources = manifest.files.map((file) => file?.path);
  if (JSON.stringify(actualSources) !== JSON.stringify(expectedSources)) {
    throw new Error('Offline dictionary manifest does not list the complete source set in canonical order.');
  }
  const expectedAssets = [];
  let totalBytes = 0;
  for (const file of manifest.files) {
    const relativeSourcePath = file.path.slice('data/'.length);
    const expectedAssetPath = relativeSourcePath === 'wordnet/LICENSE'
      ? 'data/offline-dictionaries/wordnet/LICENSE.bin'
      : `data/offline-dictionaries/${relativeSourcePath}.bin`;
    if (file.asset !== expectedAssetPath || !Number.isSafeInteger(file.compressedBytes)
      || !Number.isSafeInteger(file.uncompressedBytes) || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error(`Invalid offline dictionary file descriptor: path=${String(file.path)}`);
    }
    expectedAssets.push(file.asset);
    const compressedPath = path.join(assetDirectory, path.relative('data/offline-dictionaries', file.asset));
    const compressedBytes = readFileSync(compressedPath);
    const sourceBytes = readFileSync(path.join(sourceDirectory, relativeSourcePath));
    if (compressedBytes.length !== file.compressedBytes || sha256(compressedBytes) !== file.sha256) {
      throw new Error(`Offline dictionary compressed asset hash or size mismatch: path=${file.asset}`);
    }
    if (sourceBytes.length !== file.uncompressedBytes
      || !gunzipSync(compressedBytes, { finishFlush: zlibConstants.Z_FINISH }).equals(sourceBytes)) {
      throw new Error(`Offline dictionary asset differs from source: path=${file.path}`);
    }
    totalBytes += compressedBytes.length;
  }
  const actualAssets = listedAssetPaths(assetDirectory);
  if (JSON.stringify(actualAssets) !== JSON.stringify(expectedAssets.sort())) {
    throw new Error('Offline dictionary asset directory does not match its manifest.');
  }
  const expectedManifest = manifestFor(manifest.files);
  if (manifest.version !== expectedManifest.version || manifest.totalBytes !== totalBytes
    || manifest.totalBytes !== expectedManifest.totalBytes) {
    throw new Error('Offline dictionary manifest version or total size mismatch.');
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceDirectory = path.resolve('public/data');
  const destinationDirectory = path.resolve('public/data/offline-dictionaries');
  const manifest = buildOfflineDictionaries(sourceDirectory, destinationDirectory);
  verifyOfflineDictionaryAssets(destinationDirectory, sourceDirectory);
  console.log(`Built offline dictionaries: files=${manifest.files.length} bytes=${manifest.totalBytes}`);
}
