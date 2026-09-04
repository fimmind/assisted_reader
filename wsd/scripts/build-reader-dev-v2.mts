import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import nlp from 'compromise';

import {
  contextualDeinflectTaggedTerms,
  splitSentenceSpans,
  tagSentenceTerms,
} from '../../src/core/nlp';

const ROOT = path.basename(process.cwd()).toLowerCase() === 'wsd'
  ? path.resolve(process.cwd(), '..')
  : process.cwd();
const OUTPUT = path.join(ROOT, 'wsd/data/reader-dev-v2-draft.jsonl');
const BASE_URL = 'https://fimmind.github.io/assisted_reader/data/lexicon';
const MAX_EXAMPLES = 120;
const MAX_PER_LEMMA = 5;
const MAX_CANDIDATES = 30;
const MAX_CONTEXT_CHARS = 420;
const CANDIDATE_LEMMAS = new Set([
  'arm', 'bank', 'bar', 'base', 'board', 'body', 'book', 'bound', 'case', 'change', 'charge', 'club', 'company', 'content',
  'court', 'cover', 'crane', 'cross', 'current', 'date', 'deck', 'draft', 'face', 'fall', 'figure', 'file', 'fine', 'fly',
  'form', 'game', 'ground', 'hand', 'head', 'hold', 'interest', 'issue', 'kind', 'last', 'letter', 'light', 'line', 'mark',
  'mean', 'mine', 'model', 'motion', 'mouth', 'name', 'note', 'object', 'order', 'page', 'palm', 'paper', 'part', 'pass',
  'pitch', 'play', 'point', 'pool', 'port', 'present', 'press', 'project', 'quarter', 'race', 'range', 'right', 'ring', 'rock',
  'round', 'row', 'rule', 'scale', 'seal', 'second', 'set', 'shift', 'ship', 'show', 'spring', 'square', 'stage', 'state',
  'subject', 'table', 'term', 'tie', 'train', 'trunk', 'turn', 'watch', 'wave', 'well', 'yard',
]);

type LexiconSense = { partOfSpeech: string; definitions: string[] };
type LexiconEntry = { word: string; senses: LexiconSense[] };

function requestJson(url: string): Promise<LexiconEntry[]> {
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
      response.on('end', () => resolve(JSON.parse(body) as LexiconEntry[]));
    }).on('error', reject);
  });
}

function hashLexiconWord(word: string): number {
  let hash = 2166136261;
  for (let index = 0; index < word.length; index += 1) {
    hash ^= word.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function candidateEntries(entry: LexiconEntry) {
  let originalRank = 0;
  return entry.senses.flatMap((sense) => sense.definitions.map((gloss, index) => ({
    sense_id: `${entry.word}.${sense.partOfSpeech}.${index + 1}`,
    part_of_speech: sense.partOfSpeech,
    gloss,
    original_rank: originalRank++,
    relevance: 'needs_review',
  })));
}

function parseVocabulary(csv: string): Map<string, number> {
  const output = new Map<string, number>();
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const columns = line.split(',');
    const word = columns[2]?.trim().toLowerCase();
    if (word) output.set(word, output.size);
  }
  return output;
}

function normalizedContextKey(context: string): string {
  return context.toLowerCase().replace(/[^a-z']+/g, ' ').trim();
}

async function main() {
  const [lemmaMapText, vocabularyText] = await Promise.all([
    fs.readFile(path.join(ROOT, 'data/lemma_dict.json'), 'utf8'),
    fs.readFile(path.join(ROOT, 'data/words.csv'), 'utf8'),
  ]);
  const lemmaMap = JSON.parse(lemmaMapText) as Record<string, string>;
  const vocabulary = parseVocabulary(vocabularyText);
  const bucketCache = new Map<number, LexiconEntry[]>();
  const entryCache = new Map<string, LexiconEntry | null>();

  async function lookup(word: string): Promise<LexiconEntry | null> {
    const normalized = word.toLowerCase();
    if (entryCache.has(normalized)) return entryCache.get(normalized) ?? null;
    const bucket = hashLexiconWord(normalized) % 1024;
    let payload = bucketCache.get(bucket);
    if (!payload) {
      payload = await requestJson(`${BASE_URL}/${String(bucket).padStart(4, '0')}.json`);
      bucketCache.set(bucket, payload);
    }
    const entry = payload.find((candidate) => candidate.word === normalized) ?? null;
    entryCache.set(normalized, entry);
    return entry;
  }

  // Warm only the curated ambiguous vocabulary; exact displayed forms are
  // fetched lazily below to preserve the reader's exact-form-first behavior.
  await Promise.all([...CANDIDATE_LEMMAS].map((lemma) => lookup(lemma)));

  const examples: Array<Record<string, unknown>> = [];
  const countByLemma = new Map<string, number>();
  const contextKeysByLemma = new Map<string, Set<string>>();
  const books = ['hitchhikers_guide.txt', 'AiW.txt'];
  for (const fileName of books) {
    const text = await fs.readFile(path.join(ROOT, 'data', fileName), 'utf8');
    const sentenceSpans = splitSentenceSpans(text);
    for (let sentenceIndex = 0; sentenceIndex < sentenceSpans.length; sentenceIndex += 1) {
      const span = sentenceSpans[sentenceIndex];
      const context = span.text.replace(/\s+/g, ' ').trim();
      if (context.length > MAX_CONTEXT_CHARS) continue;
      const terms = tagSentenceTerms(context, nlp as never);
      const deinflected = contextualDeinflectTaggedTerms(
        terms, lemmaMap, vocabulary, new Set<string>(), false, nlp as never,
      );
      for (let tokenIndex = 0; tokenIndex < terms.length; tokenIndex += 1) {
        const term = terms[tokenIndex];
        const lemma = deinflected.tokens[tokenIndex];
        const pos = deinflected.partsOfSpeech[tokenIndex];
        if (!CANDIDATE_LEMMAS.has(lemma) || !pos || pos === 'proper-noun') continue;
        if ((countByLemma.get(lemma) ?? 0) >= MAX_PER_LEMMA) continue;
        const key = normalizedContextKey(context);
        const seenContexts = contextKeysByLemma.get(lemma) ?? new Set<string>();
        if (seenContexts.has(key)) continue;

        // This matches lookupDefinitionCandidate: exact displayed form first
        // when it differs from the inferred lemma, then lemma fallback.
        const displayed = term.normalized;
        const entry = (displayed !== lemma ? await lookup(displayed) : null) ?? await lookup(lemma);
        if (!entry) continue;
        const candidates = candidateEntries(entry);
        if (candidates.length < 2 || candidates.length > MAX_CANDIDATES) continue;
        const matchingPosCandidates = candidates.filter((candidate) => candidate.part_of_speech === pos).length;
        if (matchingPosCandidates === 0) continue;

        examples.push({
          id: `reader-dev-v2-${path.parse(fileName).name}-${sentenceIndex}-${tokenIndex}`,
          dataset: 'reader-dev-v2-draft',
          source: {
            file: `data/${fileName}`,
            sentence_index: sentenceIndex,
            token_index: tokenIndex,
            sentence_start: span.start,
            sentence_end: span.end,
          },
          context,
          target: term.raw,
          lookup_word: entry.word,
          lemma,
          pos,
          number_of_candidates: candidates.length,
          number_of_matching_pos_candidates: matchingPosCandidates,
          candidates,
          annotation_confidence: 'unreviewed',
          review_status: 'needs_annotation',
        });
        countByLemma.set(lemma, (countByLemma.get(lemma) ?? 0) + 1);
        seenContexts.add(key);
        contextKeysByLemma.set(lemma, seenContexts);
      }
    }
  }

  // Favor same-POS ambiguity while reserving 20% of the dataset for natural
  // one-candidate POS cases, so the full slice remains product-representative.
  examples.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const hard = examples.filter((example) => Number(example.number_of_matching_pos_candidates) >= 2);
  const easier = examples.filter((example) => Number(example.number_of_matching_pos_candidates) < 2);
  const easierTarget = Math.min(easier.length, Math.floor(MAX_EXAMPLES * 0.2));
  const hardTarget = Math.min(hard.length, MAX_EXAMPLES - easierTarget);
  const selected = [...hard.slice(0, hardTarget), ...easier.slice(0, easierTarget)];
  const selectedIds = new Set(selected.map((example) => example.id));
  for (const example of examples) {
    if (selected.length >= MAX_EXAMPLES) break;
    if (!selectedIds.has(example.id)) {
      selected.push(example);
      selectedIds.add(example.id);
    }
  }
  selected.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  await fs.writeFile(OUTPUT, `${selected.map((example) => JSON.stringify(example)).join('\n')}\n`, 'utf8');
  console.log(JSON.stringify({
    output: path.relative(ROOT, OUTPUT),
    examples: selected.length,
    same_pos: selected.filter((example) => Number(example.number_of_matching_pos_candidates) >= 2).length,
    lemmas: new Set(selected.map((example) => example.lemma)).size,
  }, null, 2));
}

await main();
