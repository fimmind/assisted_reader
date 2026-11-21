import { getDictionaryResourceGeneration, readDictionaryResource } from './offline-dictionaries';
import {
  type LemmaInflectionIndex,
  type LemmaDictionary,
  withLemmaInflectionIndex,
} from './types';

let lemmaDictPromise: Promise<LemmaDictionary> | null = null;
let lemmaGeneration = getDictionaryResourceGeneration();

const LEMMA_URL = 'data/lemma_dict.json';
const INFLECTION_INDEX_URL = 'data/lexicon/inflection-index.json';

function toSafeLemmaDict(payload: Record<string, unknown>): Record<string, string> {
  const safeDict: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') {
      safeDict[key] = value;
    }
  }
  return safeDict;
}

export async function loadLemmaDict(): Promise<LemmaDictionary> {
  const generation = getDictionaryResourceGeneration();
  if (generation !== lemmaGeneration) {
    lemmaGeneration = generation;
    lemmaDictPromise = null;
  }
  if (lemmaDictPromise) {
    return lemmaDictPromise;
  }

  const pending = loadLemmaResources().then((result) => {
    if (generation !== getDictionaryResourceGeneration()) return loadLemmaDict();
    return result;
  }).catch((error: unknown) => {
    if (lemmaDictPromise === pending) lemmaDictPromise = null;
    throw error;
  });
  lemmaDictPromise = pending;
  return lemmaDictPromise;
}

async function loadLemmaResources(): Promise<LemmaDictionary> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const [lemmaPayload, indexPayload] = await Promise.all([
        readDictionaryResource(LEMMA_URL, import.meta.env.BASE_URL),
        readDictionaryResource(INFLECTION_INDEX_URL, import.meta.env.BASE_URL),
      ]);
      if (!lemmaPayload || typeof lemmaPayload !== 'object' || Array.isArray(lemmaPayload)) {
        throw new TypeError('Lemma dictionary payload is invalid.');
      }
      if (!isSafeInflectionIndex(indexPayload as LemmaInflectionIndex)) {
        throw new TypeError('Lemma inflection index payload is invalid.');
      }
      return withLemmaInflectionIndex(toSafeLemmaDict(lemmaPayload as Record<string, unknown>), indexPayload as LemmaInflectionIndex);
    } catch (error) {
      lastError = error;
      console.warn('lemma-dict-load-attempt-failed', { attempt, lemmaUrl: LEMMA_URL, inflectionUrl: INFLECTION_INDEX_URL, error });
    }
  }
  throw lastError;
}

function isSafeInflectionIndex(payload: LemmaInflectionIndex): boolean {
  if (
    !payload ||
    payload.schemaVersion !== 1 ||
    !Array.isArray(payload.positions) ||
    !payload.positions.every((position) => typeof position === 'string') ||
    !payload.entries ||
    typeof payload.entries !== 'object'
  ) {
    return false;
  }
  return Object.values(payload.entries).every((entry) =>
    Number.isSafeInteger(entry.pos) &&
    entry.pos >= 0 &&
    !!entry.lemmas &&
    typeof entry.lemmas === 'object' &&
    Object.values(entry.lemmas).every((mask) => Number.isSafeInteger(mask) && mask > 0),
  );
}
