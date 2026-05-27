import type { LexiconEntry } from './types';

const LEXICON_INDEX_URL = 'data/lexicon/index.json';

type LexiconIndexPayload = Record<string, string>;

let lexiconPromise: Promise<Map<string, LexiconEntry>> | null = null;

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
  return (await response.json()) as LexiconEntry[];
}

export async function loadLexiconMap(): Promise<Map<string, LexiconEntry>> {
  if (lexiconPromise) {
    return lexiconPromise;
  }

  lexiconPromise = (async () => {
    const indexResponse = await fetch(`${import.meta.env.BASE_URL}${LEXICON_INDEX_URL}`);
    if (!indexResponse.ok) {
      throw new Error(`Failed to load lexicon index: status=${indexResponse.status}`);
    }

    const indexPayload = (await indexResponse.json()) as LexiconIndexPayload;
    const fileNames = Object.values(indexPayload);
    const chunkPromises = fileNames.map((fileName) => loadChunk(fileName));
    const chunkResults = await Promise.all(chunkPromises);
    const merged: LexiconEntry[] = [];
    for (const chunk of chunkResults) {
      merged.push(...chunk);
    }

    return buildEntryMap(merged);
  })();

  return lexiconPromise;
}

export function createFallbackLexiconEntry(lemma: string): LexiconEntry {
  return {
    word: lemma,
    ipa: `/${lemma}/`,
    pos: '',
    definition: 'Definition unavailable in this build.',
  };
}
