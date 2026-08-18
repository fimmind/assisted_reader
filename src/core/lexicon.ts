import { normalizeToken } from './math';
import type { DefinitionTarget, LexiconEntry, LexiconSense, PartOfSpeech } from './types';

const LEXICON_INDEX_URL = 'data/lexicon/index.json';
export const LEXICON_SCHEMA_VERSION = 3;

const PARTS_OF_SPEECH: ReadonlySet<PartOfSpeech> = new Set<PartOfSpeech>([
  'noun',
  'proper-noun',
  'verb',
  'adjective',
  'adverb',
  'pronoun',
  'determiner',
  'article',
  'preposition',
  'postposition',
  'conjunction',
  'interjection',
  'numeral',
  'particle',
  'classifier',
  'phrase',
  'abbreviation',
  'contraction',
  'prefix',
  'infix',
  'suffix',
  'symbol',
  'other',
]);

interface LexiconIndexPayload {
  schemaVersion: number;
  bucketAlgorithm: 'fnv1a-32';
  bucketCount: number;
  entryCount: number;
}

export interface LazyLexicon {
  lookup: (word: string) => Promise<LexiconEntry | null>;
}

const LEXICON_BUCKET_ALGORITHM = 'fnv1a-32';
const LEXICON_BUCKET_COUNT = 1024;
const LEXICON_FETCH_ATTEMPTS = 3;
let lexicon: LazyLexicon | null = null;

function sanitizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPartOfSpeech(value: unknown): value is PartOfSpeech {
  return typeof value === 'string' && PARTS_OF_SPEECH.has(value as PartOfSpeech);
}

function toLexiconSense(candidate: unknown): LexiconSense | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }
  const payload = candidate as Record<string, unknown>;
  if (!isPartOfSpeech(payload.partOfSpeech)) {
    return null;
  }
  const definitions = Array.isArray(payload.definitions)
    ? payload.definitions
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .slice(0, 2)
    : [];
  if (definitions.length === 0) {
    return null;
  }
  return {
    partOfSpeech: payload.partOfSpeech,
    ipa: typeof payload.ipa === 'string' ? payload.ipa.trim() : '',
    ipaUs: sanitizeOptionalText(payload.ipaUs),
    ipaUk: sanitizeOptionalText(payload.ipaUk),
    definitions,
  };
}

function toLexiconEntry(candidate: unknown): LexiconEntry | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }
  const payload = candidate as Record<string, unknown>;
  const word = typeof payload.word === 'string' ? normalizeToken(payload.word) : '';
  if (word.length === 0 || !Array.isArray(payload.senses)) {
    return null;
  }
  const senses = payload.senses
    .map((sense) => toLexiconSense(sense))
    .filter((sense): sense is LexiconSense => sense !== null);
  return { word, senses };
}

function parseLexiconIndex(candidate: unknown): LexiconIndexPayload {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Invalid lexicon index: expected an object.');
  }
  const payload = candidate as Record<string, unknown>;
  if (payload.schemaVersion !== LEXICON_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported lexicon schema: expected=${LEXICON_SCHEMA_VERSION} actual=${String(payload.schemaVersion)}`,
    );
  }
  if (payload.bucketAlgorithm !== LEXICON_BUCKET_ALGORITHM) {
    throw new Error(`Unsupported lexicon bucket algorithm: ${String(payload.bucketAlgorithm)}`);
  }
  if (payload.bucketCount !== LEXICON_BUCKET_COUNT) {
    throw new Error(
      `Unsupported lexicon bucket count: expected=${LEXICON_BUCKET_COUNT} actual=${String(payload.bucketCount)}`,
    );
  }
  if (typeof payload.entryCount !== 'number' || !Number.isInteger(payload.entryCount) || payload.entryCount <= 0) {
    throw new Error(`Invalid lexicon entry count: ${String(payload.entryCount)}`);
  }
  return {
    schemaVersion: LEXICON_SCHEMA_VERSION,
    bucketAlgorithm: LEXICON_BUCKET_ALGORITHM,
    bucketCount: LEXICON_BUCKET_COUNT,
    entryCount: payload.entryCount,
  };
}

function buildEntryMap(entries: LexiconEntry[]): Map<string, LexiconEntry> {
  const map = new Map<string, LexiconEntry>();
  for (const entry of entries) {
    if (!map.has(entry.word)) {
      map.set(entry.word, entry);
    }
  }
  return map;
}

async function fetchJsonWithRetries(relativeUrl: string): Promise<unknown> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= LEXICON_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}${relativeUrl}`);
      if (!response.ok) {
        throw new Error(`Dictionary request failed: url=${relativeUrl} status=${response.status}`);
      }
      return await response.json() as unknown;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn('lexicon-fetch-attempt-failed', {
        relativeUrl,
        attempt,
        maxAttempts: LEXICON_FETCH_ATTEMPTS,
        error: lastError.message,
      });
    }
  }
  throw lastError ?? new Error(`Dictionary request failed without an error: url=${relativeUrl}`);
}

async function loadChunk(fileName: string): Promise<Map<string, LexiconEntry>> {
  const payload = await fetchJsonWithRetries(`data/lexicon/${fileName}`);
  if (!Array.isArray(payload)) {
    throw new Error(`Invalid lexicon chunk: file=${fileName} expected=array`);
  }
  return buildEntryMap(payload
    .map((candidate) => toLexiconEntry(candidate))
    .filter((entry): entry is LexiconEntry => entry !== null));
}

function hashLexiconWord(word: string): number {
  let hash = 2166136261;
  for (let index = 0; index < word.length; index += 1) {
    hash ^= word.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

export function resolveLexiconBucketFileName(word: string): string {
  const bucketId = hashLexiconWord(normalizeToken(word)) % LEXICON_BUCKET_COUNT;
  return `${String(bucketId).padStart(4, '0')}.json`;
}

function createLazyLexicon(): LazyLexicon {
  let indexPromise: Promise<LexiconIndexPayload> | null = null;
  const bucketPromises = new Map<string, Promise<Map<string, LexiconEntry>>>();

  const loadIndex = (): Promise<LexiconIndexPayload> => {
    if (!indexPromise) {
      indexPromise = fetchJsonWithRetries(LEXICON_INDEX_URL)
        .then((payload) => parseLexiconIndex(payload))
        .catch((error: unknown) => {
          indexPromise = null;
          throw error;
        });
    }
    return indexPromise;
  };

  const loadBucket = (fileName: string): Promise<Map<string, LexiconEntry>> => {
    const existing = bucketPromises.get(fileName);
    if (existing) {
      return existing;
    }
    const pending = loadChunk(fileName).catch((error: unknown) => {
      bucketPromises.delete(fileName);
      throw error;
    });
    bucketPromises.set(fileName, pending);
    return pending;
  };

  return {
    lookup: async (rawWord: string): Promise<LexiconEntry | null> => {
      const word = normalizeToken(rawWord).trim();
      if (word.length === 0) {
        return null;
      }
      const indexPayload = await loadIndex();
      const fileName = resolveLexiconBucketFileName(word);
      const bucket = await loadBucket(fileName);
      return bucket.get(word) ?? null;
    },
  };
}

export function loadLexicon(): LazyLexicon {
  if (!lexicon) {
    lexicon = createLazyLexicon();
  }
  return lexicon;
}

export function resolveLexiconEntry(
  entry: LexiconEntry,
  target: DefinitionTarget,
): LexiconEntry {
  if (target.partOfSpeech === null) {
    return entry;
  }
  const matchingSenses = entry.senses.filter((sense) => sense.partOfSpeech === target.partOfSpeech);
  return matchingSenses.length > 0 ? { ...entry, senses: matchingSenses } : entry;
}

export function createFallbackLexiconEntry(lemma: string): LexiconEntry {
  return {
    word: normalizeToken(lemma),
    senses: [],
  };
}
