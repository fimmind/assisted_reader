import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyWordNetAssets } from '../scripts/verify-wordnet-assets.mjs';
import { hashLexiconWord, LEXICON_BUCKET_COUNT, resolveLexiconBucketFileName } from '../scripts/lexicon-schema.mjs';

test('WordNet packaging rejects missing, corrupt and inconsistent assets', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'reader-wordnet-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp('data/wordnet', directory, { recursive: true });
  await verifyWordNetAssets(directory);

  const fileName = resolveLexiconBucketFileName(hashLexiconWord('bank') % LEXICON_BUCKET_COUNT);
  const chunkPath = path.join(directory, fileName);
  const originalChunk = await readFile(chunkPath, 'utf8');
  const entries = JSON.parse(originalChunk);
  const bank = entries.find((entry) => entry.word === 'bank');
  assert.ok(bank);
  const scenarios = [
    { name: 'missing bucket', body: null, error: /ENOENT/ },
    { name: 'malformed JSON', body: '<html>404</html>', error: /Unexpected token/ },
    { name: 'empty senses', body: JSON.stringify([{ ...bank, senses: [] }]), error: /Invalid WordNet entry/ },
    { name: 'duplicate word', body: JSON.stringify([bank, bank]), error: /Duplicate WordNet entry/ },
    { name: 'wrong bucket', body: JSON.stringify([{ ...bank, word: 'river' }]), error: /wrong bucket/ },
    { name: 'duplicate POS', body: JSON.stringify([{ ...bank, senses: [bank.senses[0], bank.senses[0]] }]), error: /Duplicate WordNet POS/ },
    { name: 'duplicate synset', body: JSON.stringify([{ ...bank, senses: [{ ...bank.senses[0], definitions: [bank.senses[0].definitions[0], bank.senses[0].definitions[0]] }] }]), error: /Duplicate WordNet synset/ },
    { name: 'null definition', body: JSON.stringify([{ ...bank, senses: [{ ...bank.senses[0], definitions: [null] }] }]), error: /Invalid WordNet definition/ },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      try {
        if (scenario.body === null) {
          await rm(chunkPath);
        } else {
          await writeFile(chunkPath, scenario.body);
        }
        await assert.rejects(verifyWordNetAssets(directory), scenario.error);
      } finally {
        await writeFile(chunkPath, originalChunk);
      }
    });
  }
  const indexPath = path.join(directory, 'index.json');
  const originalIndex = await readFile(indexPath, 'utf8');
  await t.test('incorrect entry count', async () => {
    try {
      const index = JSON.parse(originalIndex);
      await writeFile(indexPath, JSON.stringify({ ...index, entryCount: index.entryCount + 1 }));
      await assert.rejects(verifyWordNetAssets(directory), /entry count mismatch/);
    } finally {
      await writeFile(indexPath, originalIndex);
    }
  });
  await t.test('null index', async () => {
    try {
      await writeFile(indexPath, 'null');
      await assert.rejects(verifyWordNetAssets(directory), /Invalid WordNet index/);
    } finally {
      await writeFile(indexPath, originalIndex);
    }
  });
  const licensePath = path.join(directory, 'LICENSE');
  const originalLicense = await readFile(licensePath, 'utf8');
  await t.test('missing license', async () => {
    try {
      await rm(licensePath);
      await assert.rejects(verifyWordNetAssets(directory), /ENOENT/);
    } finally {
      await writeFile(licensePath, originalLicense);
    }
  });
  await t.test('empty license', async () => {
    try {
      await writeFile(licensePath, '');
      await assert.rejects(verifyWordNetAssets(directory), /Missing WordNet copyright notice/);
    } finally {
      await writeFile(licensePath, originalLicense);
    }
  });
});
