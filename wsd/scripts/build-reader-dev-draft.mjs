import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUTPUT = path.join(ROOT, 'wsd/data/reader-dev-v1-draft.jsonl');
const BASE_URL = 'https://fimmind.github.io/assisted_reader/data/lexicon';
const MAX_EXAMPLES = 100;
const MIN_CANDIDATES = 3;
const MAX_CANDIDATES = 20;
const MAX_CONTEXT_CHARS = 360;
const CANDIDATE_LEMMAS = new Set([
  'arm', 'bank', 'bar', 'base', 'board', 'body', 'book', 'bound', 'case', 'change', 'charge', 'club', 'company', 'content',
  'court', 'cover', 'crane', 'cross', 'current', 'date', 'deck', 'draft', 'face', 'fall', 'figure', 'file', 'fine', 'fly',
  'form', 'game', 'ground', 'hand', 'head', 'hold', 'interest', 'issue', 'kind', 'last', 'letter', 'light', 'line', 'mark',
  'mean', 'mine', 'model', 'motion', 'mouth', 'name', 'note', 'object', 'order', 'page', 'palm', 'paper', 'part', 'pass',
  'pitch', 'play', 'point', 'pool', 'port', 'present', 'press', 'project', 'quarter', 'race', 'range', 'right', 'ring', 'rock',
  'round', 'row', 'rule', 'scale', 'seal', 'second', 'set', 'shift', 'ship', 'show', 'spring', 'square', 'stage', 'state',
  'subject', 'table', 'term', 'tie', 'train', 'trunk', 'turn', 'watch', 'wave', 'well', 'yard',
]);

function requestJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Request failed: ${url} status=${response.statusCode}`));
        response.resume();
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

function hashLexiconWord(word) {
  let hash = 2166136261;
  for (let index = 0; index < word.length; index += 1) {
    hash ^= word.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function sentences(text) {
  return text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+/g) ?? [];
}

function candidateEntries(entry) {
  return entry.senses.flatMap((sense) => sense.definitions.map((gloss, index) => ({
    sense_id: `${entry.word}.${sense.partOfSpeech}.${index + 1}`,
    part_of_speech: sense.partOfSpeech,
    gloss,
    relevance: 'needs_review',
  })));
}

async function main() {
  const lemmaMap = JSON.parse(await fs.readFile(path.join(ROOT, 'data/lemma_dict.json'), 'utf8'));
  const books = ['hitchhikers_guide.txt', 'AiW.txt'];
  const bucketWords = new Map();
  for (const lemma of CANDIDATE_LEMMAS) {
    const bucket = String(hashLexiconWord(lemma) % 1024).padStart(4, '0');
    const words = bucketWords.get(bucket) ?? [];
    words.push(lemma);
    bucketWords.set(bucket, words);
  }

  const entries = new Map();
  for (const [bucket, words] of bucketWords) {
    const payload = await requestJson(`${BASE_URL}/${bucket}.json`);
    const wanted = new Set(words);
    for (const entry of payload) {
      if (wanted.has(entry.word)) entries.set(entry.word, entry);
    }
  }

  const selectedLemmas = new Set([...entries.entries()]
    .filter(([, entry]) => {
      const count = candidateEntries(entry).length;
      return count >= MIN_CANDIDATES && count <= MAX_CANDIDATES;
    })
    .map(([lemma]) => lemma));
  const examples = [];
  const seen = new Set();
  for (const fileName of books) {
    const text = await fs.readFile(path.join(ROOT, 'data', fileName), 'utf8');
    for (const sentence of sentences(text)) {
      if (sentence.trim().length > MAX_CONTEXT_CHARS) continue;
      const words = sentence.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? [];
      for (const word of words) {
        const lemma = lemmaMap[word] ?? word;
        if (!selectedLemmas.has(lemma) || seen.has(`${fileName}:${lemma}`)) continue;
        const entry = entries.get(lemma);
        const candidates = candidateEntries(entry);
        examples.push({
          id: `reader-dev-draft-${examples.length + 1}`,
          dataset: 'reader-dev-v1-draft',
          source: { file: `data/${fileName}`, sentence: sentence.trim() },
          context: sentence.trim(),
          target: word,
          lemma,
          pos: null,
          candidates,
          review_status: 'needs_annotation',
        });
        seen.add(`${fileName}:${lemma}`);
        if (examples.length === MAX_EXAMPLES) break;
      }
      if (examples.length === MAX_EXAMPLES) break;
    }
    if (examples.length === MAX_EXAMPLES) break;
  }
  await fs.writeFile(OUTPUT, `${examples.map((example) => JSON.stringify(example)).join('\n')}\n`, 'utf8');
  console.log(JSON.stringify({ output: path.relative(ROOT, OUTPUT), examples: examples.length, lemmas: selectedLemmas.size }));
}

await main();
