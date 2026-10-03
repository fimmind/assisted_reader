import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectWsdModel, WSD_MODELS } from '../scripts/wsd-assets.mjs';

test('WSD availability checks complete packages and detects live removal and recovery', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-wsd-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const model = WSD_MODELS[0];
  const directory = path.join(root, model.directory);
  await mkdir(path.join(directory, 'vectors'), { recursive: true });
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const bytes = Buffer.alloc(16);
  const metadata = Buffer.from('{}');
  const manifest = {
    revision: model.revision, size: bytes.length,
    parts: [{ name: 'model.part00', size: bytes.length, sha256: hash(bytes) }],
    metadata: { 'tokenizer.json': hash(metadata), 'tokenizer_config.json': hash(metadata) },
    vectors: { format: 'float16-le', dimensions: 768, count: 1, sourceSha256: 'a'.repeat(64), buckets: {} },
  };
  for (const name of ['LICENSE', 'NOTICE.txt', 'tokenizer.json', 'tokenizer_config.json']) {
    await writeFile(path.join(directory, name), metadata);
  }
  await writeFile(path.join(directory, 'model.part00'), bytes);
  for (let index = 0; index < 1024; index += 1) {
    const name = String(index).padStart(4, '0');
    const vectors = Buffer.alloc(index === 0 ? 1536 : 0);
    manifest.vectors.buckets[name] = { count: index === 0 ? 1 : 0, bytes: vectors.length,
      metadataSha256: hash(metadata), vectorsSha256: hash(vectors) };
    await writeFile(path.join(directory, 'vectors', `${name}.json`), metadata);
    await writeFile(path.join(directory, 'vectors', `${name}.bin`), vectors);
  }
  const manifestPath = path.join(directory, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal((await inspectWsdModel(root, model)).available, true);
  for (const missing of ['manifest.json', 'tokenizer.json', 'model.part00', 'vectors/0700.bin']) {
    const target = path.join(directory, missing);
    const original = await readFile(target);
    await rm(target);
    assert.equal((await inspectWsdModel(root, model)).available, false, missing);
    await writeFile(target, original);
    assert.equal((await inspectWsdModel(root, model)).available, true, missing);
  }
  await writeFile(path.join(directory, '.building'), 'in progress');
  assert.equal((await inspectWsdModel(root, model)).available, false);
  await rm(path.join(directory, '.building'));
  await writeFile(manifestPath, 'null');
  assert.equal((await inspectWsdModel(root, model)).available, false);
  await writeFile(manifestPath, JSON.stringify({ ...manifest, parts: [{ name: '../outside', size: 16 }] }));
  assert.equal((await inspectWsdModel(root, model)).available, false);
});
