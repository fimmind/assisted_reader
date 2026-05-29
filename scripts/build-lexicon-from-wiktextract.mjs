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

function normalizeSpaces(value) {
  return value.replace(/\s+/g, ' ').trim();
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
