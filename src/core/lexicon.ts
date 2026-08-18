import { normalizeToken } from './math';
import type { DefinitionTarget, LexiconEntry, LexiconSense, PartOfSpeech } from './types';

const LEXICON_INDEX_URL = 'data/lexicon/index.json';
export const LEXICON_SCHEMA_VERSION = 2;

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
  chunks: Record<string, string>;
}

let lexiconPromise: Promise<Map<string, LexiconEntry>> | null = null;

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
  if (!payload.chunks || typeof payload.chunks !== 'object' || Array.isArray(payload.chunks)) {
    throw new Error('Invalid lexicon index: chunks must be an object.');
  }
  const chunks = Object.fromEntries(
    Object.entries(payload.chunks as Record<string, unknown>)
      .filter((entry): entry is [string, string] => (
        typeof entry[1] === 'string' && entry[1].trim().length > 0
      )),
  );
  if (Object.keys(chunks).length === 0) {
    throw new Error('Invalid lexicon index: no chunks were declared.');
  }
  return { schemaVersion: LEXICON_SCHEMA_VERSION, chunks };
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

async function loadChunk(fileName: string): Promise<LexiconEntry[]> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/lexicon/${fileName}`);
  if (!response.ok) {
    throw new Error(`Failed to load lexicon chunk: file=${fileName} status=${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error(`Invalid lexicon chunk: file=${fileName} expected=array`);
  }
  return payload
    .map((candidate) => toLexiconEntry(candidate))
    .filter((entry): entry is LexiconEntry => entry !== null);
}

export async function loadLexiconMap(): Promise<Map<string, LexiconEntry>> {
  if (lexiconPromise) {
    return lexiconPromise;
  }

  lexiconPromise = (async () => {
    try {
      const indexResponse = await fetch(`${import.meta.env.BASE_URL}${LEXICON_INDEX_URL}`);
      if (!indexResponse.ok) {
        throw new Error(`Failed to load lexicon index: status=${indexResponse.status}`);
      }
      const indexPayload = parseLexiconIndex(await indexResponse.json());
      const fileNames = Object.values(indexPayload.chunks);
      const chunkResults = await Promise.allSettled(fileNames.map((fileName) => loadChunk(fileName)));
      const merged: LexiconEntry[] = [];
      for (let index = 0; index < chunkResults.length; index += 1) {
        const result = chunkResults[index];
        if (result.status === 'fulfilled') {
          merged.push(...result.value);
          continue;
        }
        const fileName = fileNames[index] ?? 'unknown';
        console.warn('lexicon-chunk-load-failed', { fileName, error: result.reason });
      }
      return buildEntryMap(merged);
    } catch (error) {
      console.warn('lexicon-map-load-failed', { error });
      return new Map<string, LexiconEntry>();
    }
  })();

  return lexiconPromise;
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
