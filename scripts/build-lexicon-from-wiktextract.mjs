#!/usr/bin/env node

import fs from 'node:fs';
import { once } from 'node:events';
import https from 'node:https';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import {
  CANONICAL_PARTS_OF_SPEECH,
  LEXICON_BUCKET_ALGORITHM,
  LEXICON_BUCKET_COUNT,
  LEXICON_SCHEMA_VERSION,
  hashLexiconWord,
  resolveLexiconBucketFileName,
  WIKTEXTRACT_POS_MAP,
} from './lexicon-schema.mjs';

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DOWNLOADS_DIR = path.join(ROOT_DIR, 'downloads');
const WIKTEXTRACT_URL = 'https://kaikki.org/dictionary/raw-wiktextract-data.jsonl.gz';
const WIKTEXTRACT_ARCHIVE_PATH = path.join(DOWNLOADS_DIR, 'raw-wiktextract-data.jsonl.gz');
const MAX_DOWNLOAD_RETRIES = 3;
const MAX_REDIRECTS = 5;
const EXTRACT_PROGRESS_LINE_INTERVAL = 100000;
const WORDS_CSV_PATH = path.join(DATA_DIR, 'words.csv');
const CHUNK_DIR = path.join(DATA_DIR, 'lexicon');
const OVERRIDES_PATH = path.join(DATA_DIR, 'lexicon_overrides.json');
const EXTRACTION_PARTITION_COUNT = 256;
const WORD_TOKEN_PATTERN = /^[a-z]+(?:'[a-z]+)?(?:-[a-z]+(?:'[a-z]+)?)*$/;

function normalizeWord(value) {
  return String(value).trim().toLowerCase().replace(/’/g, "'").replace(/[‐‑]/g, '-');
}

function resolveBucketId(word, bucketCount) {
  return hashLexiconWord(word) % bucketCount;
}

function normalizeSpaces(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizePartOfSpeech(value, unmappedPartsOfSpeech) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const mapped = WIKTEXTRACT_POS_MAP.get(raw);
  if (mapped) {
    return mapped;
  }
  if (raw.length > 0) {
    unmappedPartsOfSpeech.add(raw);
  }
  return 'other';
}

function parseCsvRow(line) {
  const cells = [];
  let cursor = 0;
  let current = '';
  let inQuotes = false;

  while (cursor < line.length) {
    const char = line[cursor];
    if (char === '"') {
      const nextChar = line[cursor + 1];
      if (inQuotes && nextChar === '"') {
        current += '"';
        cursor += 2;
        continue;
      }
      inQuotes = !inQuotes;
      cursor += 1;
      continue;
    }
    if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      cursor += 1;
      continue;
    }
    current += char;
    cursor += 1;
  }
  cells.push(current);
  return cells;
}

function loadTargetWords() {
  const rawCsv = fs.readFileSync(WORDS_CSV_PATH, 'utf8');
  const lines = rawCsv.split(/\r?\n/);
  if (lines.length < 2) {
    throw new Error(`Invalid words CSV at ${WORDS_CSV_PATH}: expected header + rows`);
  }

  const header = parseCsvRow(lines[0]).map((cell) => cell.trim());
  const wordIndex = header.indexOf('word');
  if (wordIndex < 0) {
    throw new Error(`Invalid words CSV at ${WORDS_CSV_PATH}: "word" column is missing`);
  }

  const words = new Set();
  for (let lineNumber = 2; lineNumber <= lines.length; lineNumber += 1) {
    const line = lines[lineNumber - 1];
    if (line.trim().length === 0) {
      continue;
    }
    const cells = parseCsvRow(line);
    const normalized = normalizeWord(cells[wordIndex] ?? '');
    if (normalized.length > 0) {
      words.add(normalized);
    }
  }
  return words;
}

function loadOverrides() {
  if (!fs.existsSync(OVERRIDES_PATH)) {
    return new Map();
  }

  const payload = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
  if (!Array.isArray(payload)) {
    throw new Error(`Invalid overrides payload at ${OVERRIDES_PATH}: expected array`);
  }

  const map = new Map();
  for (const entry of payload) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const word = normalizeWord(entry.word);
    if (word.length === 0 || !Array.isArray(entry.senses)) {
      throw new Error(`Invalid lexicon override: word=${word || '<empty>'} senses must be an array`);
    }
    const senses = entry.senses.map((sense) => {
      if (!sense || typeof sense !== 'object') {
        throw new Error(`Invalid lexicon override sense: word=${word}`);
      }
      const partOfSpeech = typeof sense.partOfSpeech === 'string' ? sense.partOfSpeech.trim() : '';
      if (!CANONICAL_PARTS_OF_SPEECH.has(partOfSpeech)) {
        throw new Error(`Invalid lexicon override POS: word=${word} partOfSpeech=${partOfSpeech}`);
      }
      const definitions = Array.isArray(sense.definitions)
        ? sense.definitions
          .filter((item) => typeof item === 'string')
          .map((item) => normalizeSpaces(item))
          .filter((item) => item.length > 0)
        : [];
      if (definitions.length === 0) {
        throw new Error(`Invalid lexicon override definitions: word=${word} partOfSpeech=${partOfSpeech}`);
      }
      const ipa = typeof sense.ipa === 'string' ? normalizeSpaces(sense.ipa) : '';
      const ipaUs = typeof sense.ipaUs === 'string' ? normalizeSpaces(sense.ipaUs) : '';
      const ipaUk = typeof sense.ipaUk === 'string' ? normalizeSpaces(sense.ipaUk) : '';
      return {
        partOfSpeech,
        ipa: ipa.length > 0 ? ipa : (ipaUs || ipaUk),
        ipaUs: ipaUs.length > 0 ? ipaUs : undefined,
        ipaUk: ipaUk.length > 0 ? ipaUk : undefined,
        definitions,
      };
    });
    map.set(word, { word, senses });
  }
  return map;
}

function normalizeSoundTags(sound) {
  if (!sound || typeof sound !== 'object') {
    return [];
  }
  if (!Array.isArray(sound.tags)) {
    return [];
  }
  return sound.tags
    .filter((tag) => typeof tag === 'string')
    .map((tag) => tag.toLowerCase());
}

function isUsPronunciationTag(tag) {
  return (
    tag === 'us'
    || tag === 'u.s.'
    || tag === 'american'
    || tag === 'north-american'
    || tag === 'general-american'
    || tag === 'genam'
  );
}

function isUkPronunciationTag(tag) {
  return (
    tag === 'uk'
    || tag === 'u.k.'
    || tag === 'british'
    || tag === 'received-pronunciation'
    || tag === 'rp'
    || tag === 'england'
  );
}

function pickPronunciations(sounds) {
  if (!Array.isArray(sounds)) {
    return { ipa: '', ipaUs: '', ipaUk: '' };
  }
  let ipaUs = '';
  let ipaUk = '';
  let ipaAny = '';

  for (const sound of sounds) {
    if (!sound || typeof sound !== 'object') {
      continue;
    }
    const ipa = typeof sound.ipa === 'string' ? normalizeSpaces(sound.ipa) : '';
    if (ipa.length > 0) {
      if (ipaAny.length === 0) {
        ipaAny = ipa;
      }
      const tags = normalizeSoundTags(sound);
      const hasUs = tags.some((tag) => isUsPronunciationTag(tag));
      const hasUk = tags.some((tag) => isUkPronunciationTag(tag));
      if (hasUs && ipaUs.length === 0) {
        ipaUs = ipa;
      }
      if (hasUk && ipaUk.length === 0) {
        ipaUk = ipa;
      }
      if (ipaUs.length > 0 && ipaUk.length > 0) {
        break;
      }
    }
  }

  return {
    ipa: ipaAny,
    ipaUs,
    ipaUk,
  };
}

function normalizeGlossIdentity(gloss) {
  let base = normalizeSpaces(gloss).toLowerCase();
  while (base.startsWith('(')) {
    const closingIndex = base.indexOf(')');
    if (closingIndex < 0) {
      break;
    }
    base = normalizeSpaces(base.slice(closingIndex + 1));
  }

  const noPunctuation = base.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  let collapsed = normalizeSpaces(noPunctuation);
  if (collapsed.length === 0) {
    collapsed = normalizeSpaces(base.replace(/[^\p{L}\p{N}\s]/gu, ' '));
  }
  const inflectionMatch = collapsed.match(
    /^(simple past|past participle|past tense|present participle|gerund|plural|third person singular simple present|third-person singular simple present|alternative form|alternative spelling|alternative letter-case form|obsolete spelling|archaic spelling|misspelling|comparative|superlative)\s+of\s+(.+)$/,
  );
  if (inflectionMatch) {
    const target = normalizeSpaces(inflectionMatch[2]);
    return `inflection-of ${target}`;
  }
  return collapsed;
}

function collectPrimaryDefinitions(senses) {
  if (!Array.isArray(senses)) {
    return [];
  }

  const output = [];
  const seenIdentity = new Set();

  for (const sense of senses) {
    if (!sense || typeof sense !== 'object') {
      continue;
    }

    const candidates = [];
    if (Array.isArray(sense.glosses)) {
      for (const gloss of sense.glosses) {
        if (typeof gloss === 'string') {
          candidates.push(gloss);
        }
      }
    }
    if (Array.isArray(sense.raw_glosses)) {
      for (const rawGloss of sense.raw_glosses) {
        if (typeof rawGloss === 'string') {
          candidates.push(rawGloss);
        }
      }
    }

    for (const raw of candidates) {
      const gloss = normalizeSpaces(raw);
      if (gloss.length === 0) {
        continue;
      }
      const identity = normalizeGlossIdentity(gloss);
      if (seenIdentity.has(identity)) {
        continue;
      }
      seenIdentity.add(identity);
      output.push(gloss);
    }
  }

  return output;
}

function toFallbackEntry(word) {
  return {
    word,
    senses: [],
  };
}

function mergeExtractedRecord(entryMap, record) {
  const entry = entryMap.get(record.word) ?? { word: record.word, senses: [] };
  const existingSense = entry.senses.find((sense) => sense.partOfSpeech === record.partOfSpeech);
  if (!existingSense) {
    entry.senses.push({
      partOfSpeech: record.partOfSpeech,
      ipa: record.ipa,
      ipaUs: record.ipaUs || undefined,
      ipaUk: record.ipaUk || undefined,
      definitions: [...record.definitions],
    });
    entryMap.set(record.word, entry);
    return;
  }

  const seenDefinitions = new Set(existingSense.definitions.map((definition) => normalizeGlossIdentity(definition)));
  for (const definition of record.definitions) {
    const identity = normalizeGlossIdentity(definition);
    if (!seenDefinitions.has(identity)) {
      existingSense.definitions.push(definition);
      seenDefinitions.add(identity);
    }
  }
  if (existingSense.ipa.length === 0 && record.ipa.length > 0) {
    existingSense.ipa = record.ipa;
  }
  if (!existingSense.ipaUs && record.ipaUs.length > 0) {
    existingSense.ipaUs = record.ipaUs;
  }
  if (!existingSense.ipaUk && record.ipaUk.length > 0) {
    existingSense.ipaUk = record.ipaUk;
  }
}

async function writePartitionRecord(stream, record) {
  if (stream.write(`${JSON.stringify(record)}\n`)) {
    return;
  }
  await once(stream, 'drain');
}

async function closeWriteStream(stream) {
  stream.end();
  await once(stream, 'finish');
}

async function partitionEnglishLexicon(inputPath, partitionDir) {
  await fs.promises.mkdir(partitionDir, { recursive: true });
  const streams = Array.from({ length: EXTRACTION_PARTITION_COUNT }, (_, partitionId) => (
    fs.createWriteStream(path.join(partitionDir, `${partitionId}.jsonl`))
  ));
  const unmappedPartsOfSpeech = new Set();
  const inputStream = fs.createReadStream(inputPath);
  const textStream = inputPath.endsWith('.gz') ? inputStream.pipe(zlib.createGunzip()) : inputStream;
  const lineReader = readline.createInterface({ input: textStream, crlfDelay: Infinity });
  let scannedLines = 0;
  let compatibleRecords = 0;

  try {
    for await (const line of lineReader) {
      scannedLines += 1;
      if (scannedLines % EXTRACT_PROGRESS_LINE_INTERVAL === 0) {
        console.log('lexicon-extract-progress', { scannedLines, compatibleRecords });
      }
      if (line.trim().length === 0) {
        continue;
      }

      let payload;
      try {
        payload = JSON.parse(line);
      } catch (error) {
        throw new SyntaxError(`Invalid Wiktextract JSONL: line=${scannedLines} error=${String(error)}`);
      }
      if (!payload || typeof payload !== 'object' || payload.lang_code !== 'en') {
        continue;
      }
      const word = normalizeWord(payload.word);
      if (!WORD_TOKEN_PATTERN.test(word)) {
        continue;
      }
      const definitions = collectPrimaryDefinitions(payload.senses);
      if (definitions.length === 0) {
        continue;
      }
      const pronunciations = pickPronunciations(payload.sounds);
      const record = {
        word,
        partOfSpeech: normalizePartOfSpeech(payload.pos, unmappedPartsOfSpeech),
        ipa: pronunciations.ipa,
        ipaUs: pronunciations.ipaUs,
        ipaUk: pronunciations.ipaUk,
        definitions,
      };
      const partitionId = resolveBucketId(word, EXTRACTION_PARTITION_COUNT);
      await writePartitionRecord(streams[partitionId], record);
      compatibleRecords += 1;
    }
  } finally {
    await Promise.all(streams.map((stream) => closeWriteStream(stream)));
  }

  if (unmappedPartsOfSpeech.size > 0) {
    console.warn('lexicon-unmapped-parts-of-speech', {
      values: Array.from(unmappedPartsOfSpeech).sort(),
    });
  }
  console.log('lexicon-extract-complete', { scannedLines, compatibleRecords });
}

async function loadPartitionEntries(partitionPath) {
  const entryMap = new Map();
  const lineReader = readline.createInterface({
    input: fs.createReadStream(partitionPath),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  for await (const line of lineReader) {
    lineNumber += 1;
    if (line.length === 0) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new SyntaxError(`Invalid temporary lexicon partition: path=${partitionPath} line=${lineNumber} error=${String(error)}`);
    }
    mergeExtractedRecord(entryMap, record);
  }
  return entryMap;
}

async function buildLazyLexiconBuckets(partitionDir, outputDir, targetWords, overridesMap) {
  await fs.promises.mkdir(outputDir, { recursive: true });
  const targetsByPartition = new Map();
  for (const word of targetWords) {
    if (!WORD_TOKEN_PATTERN.test(word)) {
      continue;
    }
    const partitionId = resolveBucketId(word, EXTRACTION_PARTITION_COUNT);
    const words = targetsByPartition.get(partitionId) ?? [];
    words.push(word);
    targetsByPartition.set(partitionId, words);
  }
  const overridesByPartition = new Map();
  for (const [word, entry] of overridesMap.entries()) {
    if (!WORD_TOKEN_PATTERN.test(word)) {
      continue;
    }
    const partitionId = resolveBucketId(word, EXTRACTION_PARTITION_COUNT);
    const entries = overridesByPartition.get(partitionId) ?? [];
    entries.push(entry);
    overridesByPartition.set(partitionId, entries);
  }

  let totalWords = 0;
  let totalSenseGroups = 0;
  let multiPartOfSpeechWords = 0;
  let fallbackWords = 0;
  for (let partitionId = 0; partitionId < EXTRACTION_PARTITION_COUNT; partitionId += 1) {
    const partitionPath = path.join(partitionDir, `${partitionId}.jsonl`);
    const entryMap = await loadPartitionEntries(partitionPath);
    for (const word of targetsByPartition.get(partitionId) ?? []) {
      if (!entryMap.has(word)) {
        entryMap.set(word, toFallbackEntry(word));
        fallbackWords += 1;
      }
    }
    for (const entry of overridesByPartition.get(partitionId) ?? []) {
      entryMap.set(entry.word, entry);
    }

    const entriesByBucket = new Map();
    for (const entry of entryMap.values()) {
      const bucketId = resolveBucketId(entry.word, LEXICON_BUCKET_COUNT);
      const entries = entriesByBucket.get(bucketId) ?? [];
      entries.push(entry);
      entriesByBucket.set(bucketId, entries);
      totalWords += 1;
      totalSenseGroups += entry.senses.length;
      if (entry.senses.length > 1) {
        multiPartOfSpeechWords += 1;
      }
    }

    for (let bucketId = partitionId; bucketId < LEXICON_BUCKET_COUNT; bucketId += EXTRACTION_PARTITION_COUNT) {
      const entries = entriesByBucket.get(bucketId) ?? [];
      entries.sort((left, right) => left.word.localeCompare(right.word));
      await writeJsonFile(path.join(outputDir, resolveLexiconBucketFileName(bucketId)), entries);
    }
    if ((partitionId + 1) % 16 === 0 || partitionId === EXTRACTION_PARTITION_COUNT - 1) {
      console.log('lexicon-bucket-progress', {
        processedPartitions: partitionId + 1,
        totalPartitions: EXTRACTION_PARTITION_COUNT,
        totalWords,
      });
    }
  }
  return { totalWords, totalSenseGroups, multiPartOfSpeechWords, fallbackWords };
}

async function writeJsonFile(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const serialized = JSON.stringify(value);
  await fs.promises.writeFile(filePath, serialized, 'utf8');
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function removeFileIfExists(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined;
    if (code !== 'ENOENT') {
      throw error;
    }
  }
}

function downloadFileWithRedirects(url, destinationPath, redirectCount) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      const statusCode = response.statusCode ?? 0;
      const location = response.headers.location;
      const isRedirect = statusCode >= 300 && statusCode < 400;

      if (isRedirect && typeof location === 'string') {
        response.resume();
        if (redirectCount >= MAX_REDIRECTS) {
          reject(new Error(`Too many redirects while downloading wiktextract archive: status=${statusCode} url=${url}`));
          return;
        }
        const nextUrl = new URL(location, url).toString();
        resolve(downloadFileWithRedirects(nextUrl, destinationPath, redirectCount + 1));
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`Wiktextract download failed: status=${statusCode} url=${url}`));
        return;
      }

      const output = fs.createWriteStream(destinationPath);
      response.pipe(output);
      output.on('finish', () => {
        output.close(() => resolve());
      });
      output.on('error', (error) => {
        output.destroy();
        reject(error);
      });
      response.on('error', (error) => {
        output.destroy(error);
        reject(error);
      });
    });

    request.on('error', (error) => {
      reject(error);
    });
  });
}

async function downloadWiktextractArchive(destinationPath) {
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  const partialPath = `${destinationPath}.partial`;
  await removeFileIfExists(partialPath);

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt += 1) {
    try {
      console.log('wiktextract-download-start', {
        attempt,
        maxAttempts: MAX_DOWNLOAD_RETRIES,
        url: WIKTEXTRACT_URL,
        destinationPath,
      });
      await downloadFileWithRedirects(WIKTEXTRACT_URL, partialPath, 0);
      await fs.promises.rename(partialPath, destinationPath);
      console.log('wiktextract-download-complete', {
        destinationPath,
      });
      return;
    } catch (error) {
      lastError = error;
      await removeFileIfExists(partialPath);
      console.warn('wiktextract-download-attempt-failed', {
        attempt,
        maxAttempts: MAX_DOWNLOAD_RETRIES,
        error: String(error),
      });
      if (attempt < MAX_DOWNLOAD_RETRIES) {
        await delay(attempt * 1000);
      }
    }
  }

  throw lastError;
}

async function ensureWiktextractArchivePath() {
  if (fs.existsSync(WIKTEXTRACT_ARCHIVE_PATH)) {
    console.log('wiktextract-archive-reused', {
      archivePath: WIKTEXTRACT_ARCHIVE_PATH,
    });
    return WIKTEXTRACT_ARCHIVE_PATH;
  }

  await downloadWiktextractArchive(WIKTEXTRACT_ARCHIVE_PATH);
  return WIKTEXTRACT_ARCHIVE_PATH;
}

async function main() {
  const archivePath = await ensureWiktextractArchivePath();
  const targetWords = loadTargetWords();
  const overridesMap = loadOverrides();
  const buildId = `${process.pid}-${Date.now()}`;
  const partitionDir = path.join(DOWNLOADS_DIR, `lexicon-partitions-${buildId}`);
  const outputDir = path.join(DATA_DIR, `lexicon-output-${buildId}`);

  try {
    await partitionEnglishLexicon(archivePath, partitionDir);
    const summary = await buildLazyLexiconBuckets(
      partitionDir,
      outputDir,
      targetWords,
      overridesMap,
    );
    const indexPayload = {
      schemaVersion: LEXICON_SCHEMA_VERSION,
      bucketAlgorithm: LEXICON_BUCKET_ALGORITHM,
      bucketCount: LEXICON_BUCKET_COUNT,
      entryCount: summary.totalWords,
    };
    await writeJsonFile(path.join(outputDir, 'index.json'), indexPayload);

    await fs.promises.rm(CHUNK_DIR, { recursive: true, force: true });
    await fs.promises.rename(outputDir, CHUNK_DIR);
    console.log('lexicon-build-complete', {
      schemaVersion: LEXICON_SCHEMA_VERSION,
      bucketAlgorithm: LEXICON_BUCKET_ALGORITHM,
      bucketCount: LEXICON_BUCKET_COUNT,
      overrides: overridesMap.size,
      ...summary,
    });
  } finally {
    await fs.promises.rm(partitionDir, { recursive: true, force: true });
    await fs.promises.rm(outputDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('lexicon-build-failed', { error: String(error) });
  process.exitCode = 1;
});
