import { normalizeToken, orderedUnique } from './math';
import type {
  DefinitionTarget,
  LexiconEntry,
  LexiconSense,
  PartOfSpeech,
} from './types';

const LEXICON_INDEX_URL = 'data/lexicon/index.json';
const WORDNET_INDEX_URL = 'data/wordnet/index.json';
export const LEXICON_SCHEMA_VERSION = 5;
export const WORDNET_SCHEMA_VERSION = 1;

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

interface WordNetIndexPayload {
  schemaVersion: number;
  wordnetVersion: '3.0';
  bucketAlgorithm: 'fnv1a-32';
  bucketCount: number;
  entryCount: number;
}

export interface WordNetDefinition {
  id: string;
  gloss: string;
}

export interface WordNetSenseGroup {
  partOfSpeech: 'noun' | 'verb' | 'adjective' | 'adverb';
  definitions: WordNetDefinition[];
}

export interface WordNetEntry {
  word: string;
  senses: WordNetSenseGroup[];
}

export interface LazyWordNet {
  lookup: (word: string) => Promise<WordNetEntry | null>;
}

export interface LazyLexicon {
  lookup: (word: string) => Promise<LexiconEntry | null>;
}

export interface ResolvedPronunciations {
  preferred: string;
  alternatives: string[];
}

export function resolveLexiconPronunciations(
  sense: LexiconSense,
  variant: 'US' | 'UK',
): ResolvedPronunciations {
  const selected = variant === 'UK' ? sense.ipaUk?.trim() : sense.ipaUs?.trim();
  const other = variant === 'UK' ? sense.ipaUs?.trim() : sense.ipaUk?.trim();
  const generic = sense.ipa.trim();
  const preferred = selected || (generic !== other ? generic : '');
  return {
    preferred,
    alternatives: orderedUnique([selected ?? '', generic].filter((ipa) => ipa.length > 0 && ipa !== preferred && ipa !== other)),
  };
}

const LEXICON_BUCKET_ALGORITHM = 'fnv1a-32';
const LEXICON_BUCKET_COUNT = 1024;
const LEXICON_FETCH_ATTEMPTS = 3;
let lexicon: LazyLexicon | null = null;
let wiktionaryLexicon: LazyLexicon | null = null;
let wordNetLexicon: LazyWordNet | null = null;

function sanitizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPartOfSpeech(value: unknown): value is PartOfSpeech {
  return (
    typeof value === 'string' && PARTS_OF_SPEECH.has(value as PartOfSpeech)
  );
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
  const word =
    typeof payload.word === 'string' ? normalizeToken(payload.word) : '';
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
    throw new Error(
      `Unsupported lexicon bucket algorithm: ${String(payload.bucketAlgorithm)}`,
    );
  }
  if (payload.bucketCount !== LEXICON_BUCKET_COUNT) {
    throw new Error(
      `Unsupported lexicon bucket count: expected=${LEXICON_BUCKET_COUNT} actual=${String(payload.bucketCount)}`,
    );
  }
  if (
    typeof payload.entryCount !== 'number' ||
    !Number.isInteger(payload.entryCount) ||
    payload.entryCount <= 0
  ) {
    throw new Error(
      `Invalid lexicon entry count: ${String(payload.entryCount)}`,
    );
  }
  return {
    schemaVersion: LEXICON_SCHEMA_VERSION,
    bucketAlgorithm: LEXICON_BUCKET_ALGORITHM,
    bucketCount: LEXICON_BUCKET_COUNT,
    entryCount: payload.entryCount,
  };
}

function parseWordNetIndex(candidate: unknown): WordNetIndexPayload {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Invalid WordNet index: expected an object.');
  }
  const payload = candidate as Record<string, unknown>;
  if (payload.schemaVersion !== WORDNET_SCHEMA_VERSION || payload.wordnetVersion !== '3.0') {
    throw new Error(
      `Unsupported WordNet schema: expected=${WORDNET_SCHEMA_VERSION}/3.0 actual=${String(payload.schemaVersion)}/${String(payload.wordnetVersion)}`,
    );
  }
  if (payload.bucketAlgorithm !== LEXICON_BUCKET_ALGORITHM || payload.bucketCount !== LEXICON_BUCKET_COUNT) {
    throw new Error(
      `Invalid WordNet bucket layout: algorithm=${String(payload.bucketAlgorithm)} count=${String(payload.bucketCount)}`,
    );
  }
  if (typeof payload.entryCount !== 'number' || !Number.isInteger(payload.entryCount) || payload.entryCount <= 0) {
    throw new Error(`Invalid WordNet entry count: ${String(payload.entryCount)}`);
  }
  return {
    schemaVersion: WORDNET_SCHEMA_VERSION,
    wordnetVersion: '3.0',
    bucketAlgorithm: LEXICON_BUCKET_ALGORITHM,
    bucketCount: LEXICON_BUCKET_COUNT,
    entryCount: payload.entryCount,
  };
}

function parseWordNetEntry(candidate: unknown): WordNetEntry {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Invalid WordNet entry: expected an object.');
  }
  const payload = candidate as Record<string, unknown>;
  if (typeof payload.word !== 'string' || !Array.isArray(payload.senses) || payload.senses.length === 0) {
    throw new Error('Invalid WordNet entry: expected word and senses.');
  }
  const word = normalizeToken(payload.word);
  if (!/^[a-z]+(?:'[a-z]+)?(?:-[a-z]+(?:'[a-z]+)?)*$/.test(word) || word !== payload.word) {
    throw new Error(`Invalid WordNet headword: word=${String(payload.word)}`);
  }
  const seenPartsOfSpeech = new Set<string>();
  const senses: WordNetSenseGroup[] = payload.senses.map((candidateSense: unknown) => {
    if (!candidateSense || typeof candidateSense !== 'object') {
      throw new Error(`Invalid WordNet sense group: word=${word}`);
    }
    const sense = candidateSense as Record<string, unknown>;
    const partOfSpeech = sense.partOfSpeech;
    if (
      partOfSpeech !== 'noun' && partOfSpeech !== 'verb'
      && partOfSpeech !== 'adjective' && partOfSpeech !== 'adverb'
    ) {
      throw new Error(`Invalid WordNet part of speech: word=${word} pos=${String(partOfSpeech)}`);
    }
    if (seenPartsOfSpeech.has(partOfSpeech)) {
      throw new Error(`Duplicate WordNet part of speech: word=${word} pos=${partOfSpeech}`);
    }
    seenPartsOfSpeech.add(partOfSpeech);
    if (!Array.isArray(sense.definitions) || sense.definitions.length === 0) {
      throw new Error(`Missing WordNet definitions: word=${word} pos=${partOfSpeech}`);
    }
    const seenIds = new Set<string>();
    const definitions: WordNetDefinition[] = sense.definitions.map((candidateDefinition: unknown) => {
      if (!candidateDefinition || typeof candidateDefinition !== 'object') {
        throw new Error(`Invalid WordNet definition: word=${word} pos=${partOfSpeech}`);
      }
      const definition = candidateDefinition as Record<string, unknown>;
      if (
        typeof definition.id !== 'string' || definition.id.trim().length === 0
        || typeof definition.gloss !== 'string' || definition.gloss.trim().length === 0
      ) {
        throw new Error(`Invalid WordNet definition content: word=${word} pos=${partOfSpeech}`);
      }
      if (seenIds.has(definition.id)) {
        throw new Error(`Duplicate WordNet synset: word=${word} id=${definition.id}`);
      }
      seenIds.add(definition.id);
      return { id: definition.id, gloss: definition.gloss.trim() };
    });
    return { partOfSpeech, definitions };
  });
  return { word, senses };
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

async function fetchJsonWithRetries(relativeUrl: string, baseUrl: string): Promise<unknown> {
  const url = `${baseUrl}${relativeUrl}`;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= LEXICON_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (!response.ok) {
        throw new Error(
          `Dictionary request failed: url=${url} status=${response.status} body=${body.slice(0, 500)}`,
        );
      }
      try {
        return JSON.parse(body) as unknown;
      } catch (error) {
        throw new SyntaxError(
          `Invalid dictionary JSON: url=${url} status=${response.status} body=${body.slice(0, 500)}`,
          { cause: error },
        );
      }
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
  throw (
    lastError ??
    new Error(`Dictionary request failed without an error: url=${relativeUrl}`)
  );
}

async function loadChunk(fileName: string, baseUrl: string): Promise<Map<string, LexiconEntry>> {
  const payload = await fetchJsonWithRetries(`data/lexicon/${fileName}`, baseUrl);
  if (!Array.isArray(payload)) {
    throw new Error(`Invalid lexicon chunk: file=${fileName} expected=array`);
  }
  return buildEntryMap(
    payload
      .map((candidate) => toLexiconEntry(candidate))
      .filter((entry): entry is LexiconEntry => entry !== null),
  );
}

async function loadWordNetChunk(fileName: string, baseUrl: string): Promise<Map<string, WordNetEntry>> {
  const payload = await fetchJsonWithRetries(`data/wordnet/${fileName}`, baseUrl);
  if (!Array.isArray(payload)) {
    throw new Error(`Invalid WordNet chunk: file=${fileName} expected=array`);
  }
  const entries = payload.map((candidate: unknown) => parseWordNetEntry(candidate));
  const map = new Map<string, WordNetEntry>();
  for (const entry of entries) {
    if (resolveLexiconBucketFileName(entry.word) !== fileName) {
      throw new Error(`WordNet entry is in the wrong bucket: word=${entry.word} file=${fileName}`);
    }
    if (map.has(entry.word)) {
      throw new Error(`Duplicate WordNet entry: word=${entry.word} file=${fileName}`);
    }
    map.set(entry.word, entry);
  }
  return map;
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

export function createLazyWiktionaryLexicon(baseUrl: string): LazyLexicon {
  let indexPromise: Promise<LexiconIndexPayload> | null = null;
  const bucketPromises = new Map<string, Promise<Map<string, LexiconEntry>>>();

  const loadIndex = (): Promise<LexiconIndexPayload> => {
    if (!indexPromise) {
      indexPromise = fetchJsonWithRetries(LEXICON_INDEX_URL, baseUrl)
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
    const pending = loadChunk(fileName, baseUrl).catch((error: unknown) => {
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
      await loadIndex();
      const fileName = resolveLexiconBucketFileName(word);
      const bucket = await loadBucket(fileName);
      return bucket.get(word) ?? null;
    },
  };
}

export function loadWiktionaryLexicon(): LazyLexicon {
  if (!wiktionaryLexicon) {
    wiktionaryLexicon = createLazyWiktionaryLexicon(import.meta.env.BASE_URL);
  }
  return wiktionaryLexicon;
}

export function createLazyWordNet(baseUrl: string): LazyWordNet {
  let indexPromise: Promise<WordNetIndexPayload> | null = null;
  const bucketPromises = new Map<string, Promise<Map<string, WordNetEntry>>>();

  const loadIndex = (): Promise<WordNetIndexPayload> => {
    if (!indexPromise) {
      indexPromise = fetchJsonWithRetries(WORDNET_INDEX_URL, baseUrl)
        .then((payload) => parseWordNetIndex(payload))
        .catch((error: unknown) => {
          indexPromise = null;
          throw error;
        });
    }
    return indexPromise;
  };

  const loadBucket = (fileName: string): Promise<Map<string, WordNetEntry>> => {
    const existing = bucketPromises.get(fileName);
    if (existing) {
      return existing;
    }
    const pending = loadWordNetChunk(fileName, baseUrl).catch((error: unknown) => {
      bucketPromises.delete(fileName);
      throw error;
    });
    bucketPromises.set(fileName, pending);
    return pending;
  };

  return {
    lookup: async (rawWord: string): Promise<WordNetEntry | null> => {
      const word = normalizeToken(rawWord).trim();
      if (word.length === 0) {
        return null;
      }
      await loadIndex();
      const fileName = resolveLexiconBucketFileName(word);
      const bucket = await loadBucket(fileName);
      return bucket.get(word) ?? null;
    },
  };
}

export function loadWordNet(): LazyWordNet {
  if (!wordNetLexicon) {
    wordNetLexicon = createLazyWordNet(import.meta.env.BASE_URL);
  }
  return wordNetLexicon;
}

function withSharedPronunciation(entry: LexiconEntry): LexiconEntry {
  const pronounced = entry.senses.filter((sense) =>
    sense.ipa.length > 0 || Boolean(sense.ipaUs) || Boolean(sense.ipaUk),
  );
  const shared = pronounced[0];
  if (!shared || pronounced.some((sense) =>
    sense.ipa !== shared.ipa || sense.ipaUs !== shared.ipaUs || sense.ipaUk !== shared.ipaUk,
  )) {
    return entry;
  }
  return {
    ...entry,
    senses: entry.senses.map((sense) =>
      sense.ipa.length > 0 || sense.ipaUs || sense.ipaUk
        ? sense
        : { ...sense, ipa: shared.ipa, ipaUs: shared.ipaUs, ipaUk: shared.ipaUk },
    ),
  };
}

export function combineDictionaryEntries(
  wiktionaryEntry: LexiconEntry | null,
  wordNetEntry: WordNetEntry | null,
): LexiconEntry | null {
  if (!wordNetEntry) {
    return wiktionaryEntry ? withSharedPronunciation(wiktionaryEntry) : null;
  }
  const wordNetSenses: LexiconSense[] = wordNetEntry.senses.map((sense) => {
    const pronunciation = wiktionaryEntry?.senses.find(
      (candidate) => candidate.partOfSpeech === sense.partOfSpeech,
    );
    return {
      partOfSpeech: sense.partOfSpeech,
      ipa: pronunciation?.ipa ?? '',
      ipaUs: pronunciation?.ipaUs,
      ipaUk: pronunciation?.ipaUk,
      definitions: orderedUnique(sense.definitions.map((definition) => definition.gloss)),
      source: 'wordnet',
    };
  });
  const wordNetPartsOfSpeech = new Set(wordNetSenses.map((sense) => sense.partOfSpeech));
  const wiktionaryOnlySenses = wiktionaryEntry?.senses.filter(
    (sense) => !wordNetPartsOfSpeech.has(sense.partOfSpeech),
  ) ?? [];
  return withSharedPronunciation({
    word: wiktionaryEntry?.word ?? wordNetEntry.word,
    senses: [...wordNetSenses, ...wiktionaryOnlySenses],
  });
}

export function loadLexicon(): LazyLexicon {
  if (!lexicon) {
    lexicon = createLexicon(loadWiktionaryLexicon(), loadWordNet());
  }
  return lexicon;
}

export function createLexicon(wiktionary: LazyLexicon, wordNet: LazyWordNet): LazyLexicon {
  return {
    lookup: async (word: string): Promise<LexiconEntry | null> => {
      const [wiktionaryEntry, wordNetEntry] = await Promise.all([
        wiktionary.lookup(word),
        wordNet.lookup(word),
      ]);
      return combineDictionaryEntries(wiktionaryEntry, wordNetEntry);
    },
  };
}

export function resolveLexiconEntry(
  entry: LexiconEntry,
  target: DefinitionTarget,
): LexiconEntry {
  if (target.partOfSpeech === null) {
    return entry;
  }
  const matchingSenses = entry.senses.filter(
    (sense) => sense.partOfSpeech === target.partOfSpeech,
  );
  return matchingSenses.length > 0
    ? { ...entry, senses: matchingSenses }
    : entry;
}

export function createFallbackLexiconEntry(lemma: string): LexiconEntry {
  return {
    word: normalizeToken(lemma),
    senses: [],
  };
}
