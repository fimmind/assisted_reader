#!/usr/bin/env node

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DOWNLOADS_DIR = path.join(ROOT_DIR, 'downloads');
const WIKTEXTRACT_URL = 'https://kaikki.org/dictionary/raw-wiktextract-data.jsonl.gz';
const WIKTEXTRACT_ARCHIVE_PATH = path.join(DOWNLOADS_DIR, 'raw-wiktextract-data.jsonl.gz');
const MAX_DOWNLOAD_RETRIES = 3;
const MAX_REDIRECTS = 5;
const WORDS_CSV_PATH = path.join(DATA_DIR, 'words.csv');
const CHUNK_DIR = path.join(DATA_DIR, 'lexicon');
const INDEX_OUTPUT_PATH = path.join(CHUNK_DIR, 'index.json');
const OVERRIDES_PATH = path.join(DATA_DIR, 'lexicon_overrides.json');

function normalizeWord(value) {
  return String(value).trim().toLowerCase();
}

function normalizeSpaces(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function resolveChunkKey(word) {
  const firstChar = word[0] ?? '_';
  return /^[a-z]$/.test(firstChar) ? firstChar : '_';
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

function loadExistingLexiconFromChunks() {
  if (!fs.existsSync(INDEX_OUTPUT_PATH)) {
    return new Map();
  }

  const indexPayload = JSON.parse(fs.readFileSync(INDEX_OUTPUT_PATH, 'utf8'));
  if (!indexPayload || typeof indexPayload !== 'object') {
    throw new Error(`Invalid existing lexicon index payload at ${INDEX_OUTPUT_PATH}: expected object`);
  }

  const map = new Map();
  const chunkNames = Object.values(indexPayload);
  for (const chunkName of chunkNames) {
    if (typeof chunkName !== 'string' || chunkName.length === 0) {
      continue;
    }
    const chunkPath = path.join(CHUNK_DIR, chunkName);
    if (!fs.existsSync(chunkPath)) {
      continue;
    }

    const chunkPayload = JSON.parse(fs.readFileSync(chunkPath, 'utf8'));
    if (!Array.isArray(chunkPayload)) {
      continue;
    }

    for (const entry of chunkPayload) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const word = normalizeWord(entry.word);
      if (word.length === 0 || map.has(word)) {
        continue;
      }
      const definition = typeof entry.definition === 'string' ? normalizeSpaces(entry.definition) : '';
      if (definition.length === 0) {
        continue;
      }

      const definitions = Array.isArray(entry.definitions)
        ? entry.definitions
          .filter((item) => typeof item === 'string')
          .map((item) => normalizeSpaces(item))
          .filter((item) => item.length > 0)
          .slice(0, 2)
        : [definition];
      const pos = typeof entry.pos === 'string' ? entry.pos.trim() : '';
      const ipa = typeof entry.ipa === 'string' ? normalizeSpaces(entry.ipa) : '';
      const ipaUs = typeof entry.ipaUs === 'string' ? normalizeSpaces(entry.ipaUs) : '';
      const ipaUk = typeof entry.ipaUk === 'string' ? normalizeSpaces(entry.ipaUk) : '';
      map.set(word, {
        word,
        ipa: ipa.length > 0 ? ipa : (ipaUs || ipaUk),
        ipaUs: ipaUs.length > 0 ? ipaUs : undefined,
        ipaUk: ipaUk.length > 0 ? ipaUk : undefined,
        pos,
        definition,
        definitions: definitions.length > 0 ? definitions : [definition],
      });
    }
  }

  return map;
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
    const definition = typeof entry.definition === 'string' ? normalizeSpaces(entry.definition) : '';
    if (word.length === 0 || definition.length === 0) {
      continue;
    }
    const ipa = typeof entry.ipa === 'string' ? normalizeSpaces(entry.ipa) : '';
    const ipaUs = typeof entry.ipaUs === 'string' ? normalizeSpaces(entry.ipaUs) : '';
    const ipaUk = typeof entry.ipaUk === 'string' ? normalizeSpaces(entry.ipaUk) : '';
    const definitions = Array.isArray(entry.definitions)
      ? entry.definitions
        .filter((item) => typeof item === 'string')
        .map((item) => normalizeSpaces(item))
        .filter((item) => item.length > 0)
      : [definition];
    const uniqueDefinitions = [];
    const seen = new Set();
    for (const item of definitions) {
      if (!seen.has(item)) {
        uniqueDefinitions.push(item);
        seen.add(item);
      }
      if (uniqueDefinitions.length >= 2) {
        break;
      }
    }
    const pos = typeof entry.pos === 'string' ? entry.pos.trim() : '';
    map.set(word, {
      word,
      ipa: ipa.length > 0 ? ipa : (ipaUs || ipaUk),
      ipaUs: ipaUs.length > 0 ? ipaUs : undefined,
      ipaUk: ipaUk.length > 0 ? ipaUk : undefined,
      pos,
      definition: uniqueDefinitions[0] ?? definition,
      definitions: uniqueDefinitions.length > 0 ? uniqueDefinitions : [definition],
    });
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
      if (output.length >= 2) {
        return output;
      }
    }
  }

  return output;
}

function toFallbackEntry(word) {
  return {
    word,
    ipa: '',
    ipaUs: undefined,
    ipaUk: undefined,
    pos: '',
    definition: 'Definition unavailable in this build.',
    definitions: ['Definition unavailable in this build.'],
  };
}

async function streamExtractLexicon(inputPath, targetWords, overridesMap) {
  const extractedMap = new Map();

  const inputStream = fs.createReadStream(inputPath);
  const textStream = inputPath.endsWith('.gz') ? inputStream.pipe(zlib.createGunzip()) : inputStream;
  const lineReader = readline.createInterface({
    input: textStream,
    crlfDelay: Infinity,
  });

  let scanned = 0;
  for await (const line of lineReader) {
    scanned += 1;
    if (line.trim().length === 0) {
      continue;
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      console.warn('wiktextract-line-parse-failed', { scanned, error: String(error) });
      continue;
    }

    if (!record || typeof record !== 'object') {
      continue;
    }
    if (record.lang_code !== 'en') {
      continue;
    }

    const word = normalizeWord(record.word);
    if (!targetWords.has(word) || extractedMap.has(word) || overridesMap.has(word)) {
      continue;
    }

    const definitions = collectPrimaryDefinitions(record.senses);
    if (definitions.length === 0) {
      continue;
    }

    const pos = typeof record.pos === 'string' ? record.pos.trim() : '';
    const pronunciations = pickPronunciations(record.sounds);
    extractedMap.set(word, {
      word,
      ipa: pronunciations.ipa,
      ipaUs: pronunciations.ipaUs.length > 0 ? pronunciations.ipaUs : undefined,
      ipaUk: pronunciations.ipaUk.length > 0 ? pronunciations.ipaUk : undefined,
      pos,
      definition: definitions[0],
      definitions,
    });
  }

  return extractedMap;
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
  const existingLexiconMap = loadExistingLexiconFromChunks();
  const extractedMap = await streamExtractLexicon(archivePath, targetWords, overridesMap);

  const entries = [];
  let reusedEntries = 0;
  let fallbackCount = 0;
  for (const word of Array.from(targetWords).sort()) {
    const overrideEntry = overridesMap.get(word);
    if (overrideEntry) {
      entries.push(overrideEntry);
      continue;
    }
    const extracted = extractedMap.get(word);
    if (extracted) {
      entries.push(extracted);
      continue;
    }
    const existing = existingLexiconMap.get(word);
    if (existing) {
      entries.push(existing);
      reusedEntries += 1;
      continue;
    }
    entries.push(toFallbackEntry(word));
    fallbackCount += 1;
  }

  const chunkMap = new Map();
  for (const entry of entries) {
    const chunkKey = resolveChunkKey(entry.word);
    const chunk = chunkMap.get(chunkKey) ?? [];
    chunk.push(entry);
    chunkMap.set(chunkKey, chunk);
  }

  const indexPayload = {};
  const orderedChunkKeys = ['_', ...'abcdefghijklmnopqrstuvwxyz'.split('')];
  for (const chunkKey of orderedChunkKeys) {
    const chunkEntries = chunkMap.get(chunkKey) ?? [];
    const chunkName = `${chunkKey}.json`;
    indexPayload[chunkKey] = chunkName;
    await writeJsonFile(path.join(CHUNK_DIR, chunkName), chunkEntries);
  }

  await writeJsonFile(INDEX_OUTPUT_PATH, indexPayload);

  console.log('lexicon-build-complete', {
    totalWords: targetWords.size,
    extractedDefinitions: extractedMap.size,
    reusedExistingEntries: reusedEntries,
    overrides: overridesMap.size,
    fallbackDefinitions: fallbackCount,
  });
}

main().catch((error) => {
  console.error('lexicon-build-failed', { error: String(error) });
  process.exitCode = 1;
});
