let lemmaDictPromise: Promise<Record<string, string>> | null = null;

const LEMMA_URL = 'data/lemma_dict.json';

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

  lemmaDictPromise = (async () => {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}${LEMMA_URL}`);
      if (!response.ok) {
        console.warn('lemma-dict-load-failed', { status: response.status });
        return {};
      }
      const payload = (await response.json()) as Record<string, unknown>;
      return toSafeLemmaDict(payload);
    } catch (error) {
      console.warn('lemma-dict-load-error', { error });
      return {};
    }
  })();

  return lemmaDictPromise;
}
