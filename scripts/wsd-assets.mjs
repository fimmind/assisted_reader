import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const WSD_MODELS = [
  { mode: 'sayedshaun', directory: 'sayedshaun-wsd', revision: '54e41c09c61ae8bd60c62e40bf483141c49ce0d3', vectors: true },
  { mode: 'glite-lens', directory: 'glite-lens', revision: 'glite-lens-seed42-context-int8-v1', vectors: true },
  { mode: 'ettin', directory: 'ettin-150m-wsd', revision: '8751b577199d1bb95b74fa2457da7065d57100ae', vectors: false },
];

/** Check every declared file without loading models or downloading embeddings. */
export async function inspectWsdModel(root, model) {
  const directory = path.join(root, model.directory);
  try {
    try {
      await stat(path.join(directory, '.building'));
      return { available: false, reason: 'Assets are being generated. Run pnpm ensure:wsd to finish an interrupted build.' };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    if (manifest.revision !== model.revision || !Array.isArray(manifest.parts)
      || manifest.parts.length < 1 || manifest.parts.length > 20
      || !Number.isSafeInteger(manifest.size) || manifest.size <= 0) {
      throw new TypeError('Invalid model manifest.');
    }
    const assets = [{ name: 'LICENSE', size: null }, { name: 'NOTICE.txt', size: null }];
    let size = 0;
    for (const [index, part] of manifest.parts.entries()) {
      if (part.name !== `model.part${String(index).padStart(2, '0')}`
        || !Number.isSafeInteger(part.size) || part.size <= 0 || !/^[a-f0-9]{64}$/.test(part.sha256)) {
        throw new TypeError('Invalid model part declaration.');
      }
      assets.push({ name: part.name, size: part.size });
      size += part.size;
    }
    if (size !== manifest.size) throw new TypeError('Model part sizes disagree with manifest.');
    const metadata = model.mode === 'ettin'
      ? ['tokenizer.json', 'tokenizer_config.json', 'answer_letters.json']
      : ['tokenizer.json', 'tokenizer_config.json'];
    for (const name of metadata) {
      if (!/^[a-f0-9]{64}$/.test(manifest.metadata?.[name] ?? '')) throw new TypeError('Missing model metadata declaration.');
      assets.push({ name, size: null });
    }
    if (model.vectors) {
      const vectors = manifest.vectors;
      if (vectors?.format !== 'float16-le' || vectors.dimensions !== 768
        || !Number.isSafeInteger(vectors.count) || vectors.count < 1
        || !/^[a-f0-9]{64}$/.test(vectors.sourceSha256 ?? '')
        || !vectors.buckets || Object.keys(vectors.buckets).length !== 1024) {
        throw new TypeError('Invalid sense vector manifest.');
      }
      let total = 0;
      for (let index = 0; index < 1024; index += 1) {
        const name = String(index).padStart(4, '0');
        const bucket = vectors.buckets[name];
        if (!bucket || !Number.isSafeInteger(bucket.count) || bucket.count < 0
          || bucket.bytes !== bucket.count * 768 * 2
          || !/^[a-f0-9]{64}$/.test(bucket.metadataSha256)
          || !/^[a-f0-9]{64}$/.test(bucket.vectorsSha256)) throw new TypeError(`Invalid vector bucket: ${name}`);
        assets.push({ name: `vectors/${name}.json`, size: null }, { name: `vectors/${name}.bin`, size: bucket.bytes });
        total += bucket.count;
      }
      if (total !== vectors.count) throw new TypeError('Vector counts disagree with manifest.');
    }
    for (let first = 0; first < assets.length; first += 32) {
      await Promise.all(assets.slice(first, first + 32).map(async (asset) => {
        const info = await stat(path.join(directory, asset.name));
        if (!info.isFile() || (asset.size === null ? info.size === 0 : info.size !== asset.size)) {
          throw new Error(`Missing or incomplete asset: ${asset.name}`);
        }
      }));
    }
    return { available: true, reason: '' };
  } catch (error) {
    if (error.code && error.code !== 'ENOENT') throw error;
    return { available: false, reason: `WSD assets unavailable: ${error.message}` };
  }
}

export async function inspectWsdAssets(root) {
  const availability = {};
  for (const model of WSD_MODELS) availability[model.mode] = await inspectWsdModel(root, model);
  return availability;
}
