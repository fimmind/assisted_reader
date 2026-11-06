import {
  type LemmaInflectionIndex,
  withLemmaInflectionIndex,
} from './types';

let lemmaDictPromise: Promise<Record<string, string>> | null = null;

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

export async function loadLemmaDict(): Promise<Record<string, string>> {
  if (lemmaDictPromise) {
    return lemmaDictPromise;
  }

  lemmaDictPromise = loadLemmaResources();
  return lemmaDictPromise;
}

async function loadLemmaResources(): Promise<Record<string, string>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const [lemmaResponse, indexResponse] = await Promise.all([
        fetch(`${import.meta.env.BASE_URL}${LEMMA_URL}`),
        fetch(`${import.meta.env.BASE_URL}${INFLECTION_INDEX_URL}`),
      ]);
      if (!lemmaResponse.ok) {
        throw new Error(`Lemma dictionary request failed: url=${LEMMA_URL} status=${lemmaResponse.status} body=${await lemmaResponse.text()}`);
      }
      if (!indexResponse.ok) {
        throw new Error(`Lemma inflection index request failed: url=${INFLECTION_INDEX_URL} status=${indexResponse.status} body=${await indexResponse.text()}`);
      }
      const [lemmaPayload, indexPayload] = await Promise.all([
        lemmaResponse.json() as Promise<Record<string, unknown>>,
        indexResponse.json() as Promise<LemmaInflectionIndex>,
      ]);
      if (!isSafeInflectionIndex(indexPayload)) {
        throw new TypeError('Lemma inflection index payload is invalid.');
      }
      return withLemmaInflectionIndex(toSafeLemmaDict(lemmaPayload), indexPayload);
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
