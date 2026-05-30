import type { LexiconEntry } from './types';

const LEXICON_INDEX_URL = 'data/lexicon/index.json';

type LexiconIndexPayload = Record<string, string>;

let lexiconPromise: Promise<Map<string, LexiconEntry>> | null = null;

function sanitizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed;
}

function toLexiconEntry(candidate: unknown): LexiconEntry | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }
  const payload = candidate as Record<string, unknown>;
  const word = typeof payload.word === 'string' ? payload.word.trim() : '';
  if (word.length === 0) {
    return null;
  }
  const definition = typeof payload.definition === 'string' ? payload.definition.trim() : '';
  const fallbackDefinition = definition.length > 0 ? definition : 'Definition unavailable in this build.';

  const rawDefinitions = Array.isArray(payload.definitions) ? payload.definitions : [];
  const definitions = rawDefinitions
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .slice(0, 2);

  return {
    word,
    ipa: typeof payload.ipa === 'string' ? payload.ipa.trim() : '',
    ipaUs: sanitizeOptionalText(payload.ipaUs),
    ipaUk: sanitizeOptionalText(payload.ipaUk),
    pos: typeof payload.pos === 'string' ? payload.pos.trim() : '',
    definition: fallbackDefinition,
    definitions: definitions.length > 0 ? definitions : undefined,
  };
}

function buildEntryMap(entries: LexiconEntry[]): Map<string, LexiconEntry> {
  const map = new Map<string, LexiconEntry>();
  for (const entry of entries) {
    const normalized = entry.word.toLowerCase();
    if (!map.has(normalized)) {
      map.set(normalized, entry);
    }
  }
  return map;
}

async function loadChunk(fileName: string): Promise<LexiconEntry[]> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/lexicon/${fileName}`);
  if (!response.ok) {
    throw new Error(`Failed to load lexicon chunk: file=${fileName} status=${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) {
    return [];
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

      const indexPayload = (await indexResponse.json()) as LexiconIndexPayload;
      const fileNames = Object.values(indexPayload);
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

export function createFallbackLexiconEntry(lemma: string): LexiconEntry {
  return {
    word: lemma,
    ipa: '',
    ipaUs: undefined,
    ipaUk: undefined,
    pos: '',
    definition: 'Definition unavailable in this build.',
    definitions: undefined,
  };
}
