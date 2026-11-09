export type CachedWsdModel = 'sayedshaun' | 'glite-lens';

export const WSD_MODEL_CACHE_NAMES: Record<CachedWsdModel, string> = {
  sayedshaun: 'easeword-sayedshaun-wsd-54e41c09-int8-v1',
  'glite-lens': 'easeword-glite-lens-seed42-int8-v1',
};

const WSD_MODEL_CACHE_PREFIXES: Record<CachedWsdModel, string> = {
  sayedshaun: 'easeword-sayedshaun-wsd-',
  'glite-lens': 'easeword-glite-lens-',
};

const MODELS: CachedWsdModel[] = ['sayedshaun', 'glite-lens'];

export async function findCachedWsdModels(storage: CacheStorage): Promise<CachedWsdModel[]> {
  const names = await storage.keys();
  const models = await Promise.all(MODELS.map(async (model): Promise<CachedWsdModel | null> => {
    for (const name of names) {
      if (name.startsWith(WSD_MODEL_CACHE_PREFIXES[model]) && await storage.has(name)) {
        const cache = await storage.open(name);
        if ((await cache.keys()).length > 0) return model;
      }
    }
    return null;
  }));
  return models.filter((model): model is CachedWsdModel => model !== null);
}

export async function deleteWsdModelCaches(storage: CacheStorage, models: CachedWsdModel[]): Promise<void> {
  const names = await storage.keys();
  for (const name of names) {
    if (models.some((model) => name.startsWith(WSD_MODEL_CACHE_PREFIXES[model]))) {
      const deleted = await storage.delete(name);
      if (!deleted && await storage.has(name)) throw new Error(`Could not delete model cache: ${name}`);
    }
  }
}
