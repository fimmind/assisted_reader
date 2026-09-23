import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  combineDictionaryEntries, createLazyWordNet, createLazyWiktionaryLexicon, createLexicon,
  resolveLexiconBucketFileName, resolveLexiconEntry, resolveLexiconPronunciations,
} from '../src/core/lexicon.js';
import type { WordNetEntry } from '../src/core/lexicon.js';
import type { LexiconEntry } from '../src/core/types.js';
import { filterWordNetEntry, paragraphWindowForWsd, sentenceWindowForWsd, wordNetGlosses } from '../src/core/wsd-filter.js';

function loadWordNetEntry(word: string): WordNetEntry {
  const fileName = resolveLexiconBucketFileName(word);
  const entries = JSON.parse(readFileSync(`data/wordnet/${fileName}`, 'utf8')) as WordNetEntry[];
  const entry = entries.find((candidate) => candidate.word === word);
  if (!entry) {
    throw new Error(`Missing generated WordNet entry: word=${word} bucket=${fileName}`);
  }
  return entry;
}

test('WordNet definitions use Wiktionary transcription for a matching POS', () => {
  const wiktionary: LexiconEntry = {
    word: 'bank',
    senses: [{ partOfSpeech: 'noun', ipa: '/bæŋk/', definitions: ['Wiktionary definition'] }],
  };
  const combined = combineDictionaryEntries(wiktionary, loadWordNetEntry('bank'));
  assert.ok(combined);
  const selected = resolveLexiconEntry(combined, { lemma: 'bank', partOfSpeech: 'noun' });
  assert.equal(selected.senses[0]?.ipa, '/bæŋk/');
  assert.equal(selected.senses[0]?.definitions[0], 'sloping land (especially the slope beside a body of water)');
  assert.ok(!selected.senses[0]?.definitions.includes('Wiktionary definition'));
});

test('Wiktionary supplies POS groups missing from WordNet', () => {
  const wiktionary: LexiconEntry = {
    word: 'a',
    senses: [{ partOfSpeech: 'article', ipa: '/ə/', definitions: ['An indefinite article.'] }],
  };
  const combined = combineDictionaryEntries(wiktionary, loadWordNetEntry('a'));
  assert.ok(combined);
  const selected = resolveLexiconEntry(combined, { lemma: 'a', partOfSpeech: 'article' });
  assert.deepEqual(selected.senses, wiktionary.senses);
});

test('identical glosses appear once on cards while distinct synsets remain in the database', () => {
  const raw = loadWordNetEntry('proportionately');
  const original = structuredClone(raw);
  const combined = combineDictionaryEntries(null, raw);
  assert.ok(combined);
  assert.equal(raw.senses[0].definitions.length, 3);
  assert.deepEqual(combined.senses[0].definitions, ['to a proportionate degree', 'in proportion']);
  assert.deepEqual(raw, original);
});

test('contextual filtering changes WordNet definitions but preserves Wiktionary-only groups', () => {
  const wiktionary: LexiconEntry = {
    word: 'bank',
    senses: [{ partOfSpeech: 'interjection', ipa: '', definitions: ['A shouted warning.'] }],
  };
  const combined = combineDictionaryEntries(wiktionary, loadWordNetEntry('bank'));
  assert.ok(combined);
  const glosses = wordNetGlosses(combined);
  assert.ok(glosses.length > 1);
  const filtered = filterWordNetEntry(combined, glosses.map((_, index) => index === 0 ? 10 : 0), 0);
  assert.deepEqual(wordNetGlosses(filtered), [glosses[0]]);
  assert.deepEqual(filtered.senses.find((sense) => sense.partOfSpeech === 'interjection')?.definitions, ['A shouted warning.']);
});

test('WSD context windows include nearby sentences or paragraphs and preserve the target span', () => {
  const paragraphs = [
    'Ford glanced round at him.',
    '“What’s that, foregone conclusion then, you reckon, sir?” said the barman. “Arsenal without a chance?”',
    'Ford shook his head.',
  ];
  const start = paragraphs[1].indexOf('conclusion');
  const context = { text: paragraphs[1], start, end: start + 'conclusion'.length };
  const sentence = sentenceWindowForWsd(paragraphs, 1, context, 1);
  const twoSentences = sentenceWindowForWsd(paragraphs, 1, context, 2);
  const paragraph = paragraphWindowForWsd(paragraphs, 1, context, 1);
  const threeParagraphs = paragraphWindowForWsd(paragraphs, 1, context, 3);
  for (const window of [sentence, twoSentences, paragraph, threeParagraphs]) {
    assert.equal(window.text.slice(window.start, window.end), 'conclusion');
  }
  assert.ok(!sentence.text.includes('said the barman'));
  assert.ok(twoSentences.text.includes('said the barman'));
  assert.equal(paragraph.text, paragraphs[1]);
  assert.ok(threeParagraphs.text.includes(paragraphs[0]));
  assert.ok(threeParagraphs.text.includes(paragraphs[2]));
});

interface Reply {
  status: number;
  body: string;
}

interface DictionaryServer {
  server: Server;
  baseUrl: string;
  requests: string[];
  overrides: Map<string, Reply[]>;
}

const wiktionaryEntries: LexiconEntry[] = [
  {
    word: 'bank',
    senses: [{ partOfSpeech: 'noun', ipa: '/bæŋk/', ipaUs: '/bæŋk/', ipaUk: '/bæŋk/', definitions: ['Wiktionary bank definition.'] }],
  },
  {
    word: 'a',
    senses: [{ partOfSpeech: 'article', ipa: '/ə/', definitions: ['An indefinite article.'] }],
  },
  {
    word: 'herself',
    senses: [{ partOfSpeech: 'pronoun', ipa: '/hɜːsɛlf/', definitions: ['The reflexive form of she.'] }],
  },
];

async function startDictionaryServer(): Promise<DictionaryServer> {
  const requests: string[] = [];
  const overrides = new Map<string, Reply[]>();
  const server = createServer((request, response) => {
    const route = request.url ?? '';
    requests.push(route);
    const override = overrides.get(route)?.shift();
    if (override) {
      response.writeHead(override.status, { 'Content-Type': 'application/json' });
      response.end(override.body);
      return;
    }
    const match = /^\/assisted_reader\/data\/(wordnet|lexicon)\/(index|[0-9]{4})\.json$/.exec(route);
    if (!match) {
      response.writeHead(404);
      response.end(`Unexpected dictionary route: ${route}`);
      return;
    }
    try {
      const [source, fileName] = [match[1], `${match[2]}.json`];
      const body = source === 'wordnet'
        ? readFileSync(`data/wordnet/${fileName}`, 'utf8')
        : JSON.stringify(fileName === 'index.json'
          ? { schemaVersion: 5, bucketAlgorithm: 'fnv1a-32', bucketCount: 1024, entryCount: wiktionaryEntries.length }
          : wiktionaryEntries.filter((entry) => resolveLexiconBucketFileName(entry.word) === fileName));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(body);
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}/assisted_reader/`, requests, overrides };
}

async function closeDictionaryServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

const bankRoute = `/assisted_reader/data/wordnet/${resolveLexiconBucketFileName('bank')}`;
const indexRoute = '/assisted_reader/data/wordnet/index.json';

test('HTTP lookup is lazy, shares concurrent bucket requests, and caches misses', async (t) => {
  const fixture = await startDictionaryServer();
  t.after(() => closeDictionaryServer(fixture.server));
  const wordnet = createLazyWordNet(fixture.baseUrl);
  assert.deepEqual(fixture.requests, []);
  assert.equal(await wordnet.lookup('  '), null);
  assert.deepEqual(fixture.requests, []);
  const bucket = JSON.parse(readFileSync(`data/wordnet/${resolveLexiconBucketFileName('bank')}`, 'utf8')) as WordNetEntry[];
  const neighbor = bucket.find((entry) => entry.word !== 'bank');
  assert.ok(neighbor);
  const [first, repeated, other] = await Promise.all([
    wordnet.lookup(' BANK '), wordnet.lookup('bank'), wordnet.lookup(neighbor.word),
  ]);
  assert.deepEqual(first, loadWordNetEntry('bank'));
  assert.strictEqual(first, repeated);
  assert.equal(other?.word, neighbor.word);
  assert.deepEqual(fixture.requests, [indexRoute, bankRoute]);
  assert.equal(await wordnet.lookup('qzxqzxqzxqzx'), null);
  const count = fixture.requests.length;
  assert.equal(await wordnet.lookup('qzxqzxqzxqzx'), null);
  assert.equal(fixture.requests.length, count);
});

test('HTTP failures retry three times and a subsequent lookup can recover', async (t) => {
  const fixture = await startDictionaryServer();
  t.after(() => closeDictionaryServer(fixture.server));
  fixture.overrides.set(bankRoute, Array.from({ length: 3 }, () => ({ status: 503, body: 'temporarily unavailable' })));
  const wordnet = createLazyWordNet(fixture.baseUrl);
  await assert.rejects(wordnet.lookup('bank'), /url=.*data\/wordnet\/.*status=503 body=temporarily unavailable/);
  assert.equal(fixture.requests.filter((route) => route === bankRoute).length, 3);
  assert.deepEqual(await wordnet.lookup('bank'), loadWordNetEntry('bank'));
  assert.equal(fixture.requests.filter((route) => route === indexRoute).length, 1);
});

test('malformed JSON reports the asset URL and recovers after retry', async (t) => {
  const fixture = await startDictionaryServer();
  t.after(() => closeDictionaryServer(fixture.server));
  fixture.overrides.set(bankRoute, Array.from({ length: 3 }, () => ({ status: 200, body: '<html>not a dictionary</html>' })));
  const wordnet = createLazyWordNet(fixture.baseUrl);
  await assert.rejects(wordnet.lookup('bank'), /Invalid dictionary JSON: url=.*status=200 body=<html>/);
  assert.ok(await wordnet.lookup('bank'));
});

test('invalid index is rejected before any bucket is requested and can be reloaded', async (t) => {
  const fixture = await startDictionaryServer();
  t.after(() => closeDictionaryServer(fixture.server));
  fixture.overrides.set(indexRoute, [{ status: 200, body: JSON.stringify({ schemaVersion: 99 }) }]);
  const wordnet = createLazyWordNet(fixture.baseUrl);
  await assert.rejects(wordnet.lookup('bank'), /Unsupported WordNet schema/);
  assert.deepEqual(fixture.requests, [indexRoute]);
  assert.ok(await wordnet.lookup('bank'));
});

test('malformed bucket entries fail explicitly and are not cached', async (t) => {
  const fixture = await startDictionaryServer();
  t.after(() => closeDictionaryServer(fixture.server));
  const bank = loadWordNetEntry('bank');
  const firstSense = bank.senses[0];
  assert.ok(firstSense);
  const cases: Array<{ name: string; entries: unknown[]; error: RegExp }> = [
    { name: 'empty senses', entries: [{ ...bank, senses: [] }], error: /Invalid WordNet entry/ },
    { name: 'duplicate POS', entries: [{ ...bank, senses: [firstSense, firstSense] }], error: /Duplicate WordNet part of speech/ },
    { name: 'duplicate synset', entries: [{ ...bank, senses: [{ ...firstSense, definitions: [firstSense.definitions[0], firstSense.definitions[0]] }] }], error: /Duplicate WordNet synset/ },
    { name: 'wrong bucket', entries: [{ ...bank, word: 'river' }], error: /wrong bucket/ },
    { name: 'duplicate headword', entries: [bank, bank], error: /Duplicate WordNet entry/ },
    { name: 'null definition', entries: [{ ...bank, senses: [{ ...firstSense, definitions: [null] }] }], error: /Invalid WordNet definition/ },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      fixture.overrides.set(bankRoute, [{ status: 200, body: JSON.stringify(scenario.entries) }]);
      const wordnet = createLazyWordNet(fixture.baseUrl);
      await assert.rejects(wordnet.lookup('bank'), scenario.error);
      assert.ok(await wordnet.lookup('bank'));
    });
  }
});

test('both HTTP dictionaries compose definitions, preserve IPA and expose raw Wiktionary', async (t) => {
  const fixture = await startDictionaryServer();
  t.after(() => closeDictionaryServer(fixture.server));
  const wiktionary = createLazyWiktionaryLexicon(fixture.baseUrl);
  const wordnet = createLazyWordNet(fixture.baseUrl);
  const dictionary = createLexicon(wiktionary, wordnet);
  const bank = await dictionary.lookup('bank');
  assert.ok(bank);
  const noun = resolveLexiconEntry(bank, { lemma: 'bank', partOfSpeech: 'noun' }).senses[0];
  assert.ok(noun);
  assert.deepEqual(noun.definitions, loadWordNetEntry('bank').senses[0].definitions.map((definition) => definition.gloss));
  assert.equal(resolveLexiconPronunciations(noun, 'US').preferred, '/bæŋk/');
  assert.equal(resolveLexiconPronunciations(noun, 'UK').preferred, '/bæŋk/');
  assert.deepEqual(await wiktionary.lookup('bank'), wiktionaryEntries[0]);
  assert.deepEqual(await dictionary.lookup('herself'), await wiktionary.lookup('herself'));
  const article = await dictionary.lookup('a');
  assert.ok(article);
  assert.deepEqual(resolveLexiconEntry(article, { lemma: 'a', partOfSpeech: 'article' }).senses, (await wiktionary.lookup('a'))?.senses);
  const wordnetOnly = await dictionary.lookup('memoranda');
  assert.ok(wordnetOnly);
  assert.equal(wordnetOnly.senses[0].ipa, '');
  assert.equal(wordnetOnly.senses[0].definitions.length, 1);
  assert.equal(await dictionary.lookup('qzxqzxqzxqzx'), null);
});

test('a failed WordNet request is an error rather than a Wiktionary fallback', async (t) => {
  const fixture = await startDictionaryServer();
  t.after(() => closeDictionaryServer(fixture.server));
  fixture.overrides.set(bankRoute, Array.from({ length: 3 }, () => ({ status: 503, body: 'wordnet outage' })));
  const dictionary = createLexicon(createLazyWiktionaryLexicon(fixture.baseUrl), createLazyWordNet(fixture.baseUrl));
  await assert.rejects(dictionary.lookup('bank'), /wordnet outage/);
  assert.ok(await dictionary.lookup('bank'));
});
