import { normalizeToken } from './math';
import { getDictionaryResourceGeneration, readDictionaryResource } from './offline-dictionaries';

const HEADWORDS_PATH = 'data/lexicon/headwords.json';
let headwordsPromise: Promise<string[]> | null = null;
let headwordsGeneration = getDictionaryResourceGeneration();

async function readHeadwords(): Promise<string[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const payload = await readDictionaryResource(HEADWORDS_PATH, import.meta.env.BASE_URL);
      if (!Array.isArray(payload) || !payload.every((word: unknown) =>
        typeof word === 'string' && word.length > 0 && normalizeToken(word) === word,
      )) {
        throw new TypeError(`Invalid dictionary headword list: path=${HEADWORDS_PATH}`);
      }
      return payload as string[];
    } catch (error: unknown) {
      lastError = error;
      console.warn('dictionary-headwords-load-failed', { attempt, path: HEADWORDS_PATH, error });
    }
  }
  throw lastError;
}

export function loadDictionaryHeadwords(): Promise<string[]> {
  const generation = getDictionaryResourceGeneration();
  if (headwordsGeneration !== generation) {
    headwordsGeneration = generation;
    headwordsPromise = null;
  }
  if (!headwordsPromise) {
    const pending = readHeadwords()
      .then((words) => generation === getDictionaryResourceGeneration() ? words : loadDictionaryHeadwords())
      .catch((error: unknown) => {
        if (headwordsPromise === pending) headwordsPromise = null;
        throw error;
      });
    headwordsPromise = pending;
  }
  return headwordsPromise;
}
