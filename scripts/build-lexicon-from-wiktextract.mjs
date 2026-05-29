#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'data');
const MODEL_PATH = path.join(DATA_DIR, 'best_grouped_irt_model_model_data.json');
const FULL_OUTPUT_PATH = path.join(DATA_DIR, 'lexicon_full.json');
const CHUNK_DIR = path.join(DATA_DIR, 'lexicon');
const INDEX_OUTPUT_PATH = path.join(CHUNK_DIR, 'index.json');
const OVERRIDES_PATH = path.join(DATA_DIR, 'lexicon_overrides.json');

function normalizeWord(value) {
  return String(value).trim().toLowerCase();
}

function resolveChunkKey(word) {
  const firstChar = word[0] ?? '_';
  return /^[a-z]$/.test(firstChar) ? firstChar : '_';
}

function loadModelWords() {
  const payload = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
  if (!Array.isArray(payload.words)) {
    throw new Error(`Invalid model payload at ${MODEL_PATH}: "words" array is missing`);
  }

  const words = new Set();
  for (const word of payload.words) {
    const normalized = normalizeWord(word);
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
    const definition = typeof entry.definition === 'string' ? entry.definition.trim() : '';
    if (word.length === 0 || definition.length === 0) {
      continue;
    }
    const ipa = typeof entry.ipa === 'string' ? entry.ipa.trim() : '';
    const pos = typeof entry.pos === 'string' ? entry.pos.trim() : '';
    map.set(word, { word, ipa, pos, definition });
  }
  return map;
}

function pickIpa(sounds) {
  if (!Array.isArray(sounds)) {
    return '';
  }
  for (const sound of sounds) {
    if (!sound || typeof sound !== 'object') {
      continue;
    }
    const ipa = typeof sound.ipa === 'string' ? sound.ipa.trim() : '';
    if (ipa.length > 0) {
      return ipa;
    }
  }
  return '';
}

function pickDefinition(senses) {
  if (!Array.isArray(senses)) {
    return '';
  }
  for (const sense of senses) {
    if (!sense || typeof sense !== 'object') {
      continue;
    }
    if (Array.isArray(sense.glosses)) {
      for (const gloss of sense.glosses) {
        if (typeof gloss === 'string' && gloss.trim().length > 0) {
          return gloss.trim();
        }
      }
    }
    if (Array.isArray(sense.raw_glosses)) {
      for (const rawGloss of sense.raw_glosses) {
        if (typeof rawGloss === 'string' && rawGloss.trim().length > 0) {
          return rawGloss.trim();
        }
      }
    }
  }
  return '';
}

function toFallbackEntry(word) {
  return {
    word,
    ipa: '',
    pos: '',
    definition: 'Definition unavailable in this build.',
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

    const definition = pickDefinition(record.senses);
    if (definition.length === 0) {
      continue;
    }

    const pos = typeof record.pos === 'string' ? record.pos.trim() : '';
    const ipa = pickIpa(record.sounds);
    extractedMap.set(word, { word, ipa, pos, definition });
  }

  return extractedMap;
}

async function writeJsonFile(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const serialized = JSON.stringify(value);
  await fs.promises.writeFile(filePath, serialized, 'utf8');
}

async function main() {
  const inputPath = process.argv[2];
  if (typeof inputPath !== 'string' || inputPath.trim().length === 0) {
    throw new Error('Usage: node scripts/build-lexicon-from-wiktextract.mjs <wiktextract.jsonl|wiktextract.jsonl.gz>');
  }
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file does not exist: ${inputPath}`);
  }

  const targetWords = loadModelWords();
  const overridesMap = loadOverrides();
  const extractedMap = await streamExtractLexicon(inputPath, targetWords, overridesMap);

  const entries = [];
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
    entries.push(toFallbackEntry(word));
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

  await writeJsonFile(FULL_OUTPUT_PATH, entries);
  await writeJsonFile(INDEX_OUTPUT_PATH, indexPayload);

  console.log('lexicon-build-complete', {
    totalWords: targetWords.size,
    extractedDefinitions: extractedMap.size,
    overrides: overridesMap.size,
    fallbackDefinitions: entries.length - extractedMap.size - overridesMap.size,
  });
}

main().catch((error) => {
  console.error('lexicon-build-failed', { error: String(error) });
  process.exitCode = 1;
});
