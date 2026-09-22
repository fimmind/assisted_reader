import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import nlp from 'compromise';

import {
  contextualDeinflectTaggedTerms,
  splitSentenceSpans,
  tagSentenceTerms,
} from '../../src/core/nlp';
import { taggedTermStarts } from './tagged-term-offsets';

const ROOT = path.basename(process.cwd()).toLowerCase() === 'wsd'
  ? path.resolve(process.cwd(), '..')
  : process.cwd();
const OUTPUT = path.join(ROOT, 'wsd/data/reader-filter-dev-v1-draft.jsonl');
const OLD_DRAFT = path.join(ROOT, 'wsd/data/reader-dev-v2-draft.jsonl');
const DATASET = 'reader-filter-dev-v1-draft';
const BOOKS = ['hitchhikers_guide.txt', 'AiW.txt'];
const TARGET_EXAMPLES = 100;
const MAX_PER_LEMMA = 5;
const MIN_RUNTIME_CANDIDATES = 6;
const MAX_RUNTIME_CANDIDATES = 30;
const MAX_CONTEXT_CHARS = 420;
const OPEN_CLASS_POS = new Set(['noun', 'verb', 'adjective', 'adverb']);

type LexiconSense = Readonly<{
  partOfSpeech: string;
  definitions: readonly string[];
}>;

type LexiconEntry = Readonly<{
  word: string;
  senses: readonly LexiconSense[];
}>;

type Candidate = Readonly<{
  sense_id: string;
  part_of_speech: string;
  gloss: string;
  original_rank: number;
  relevance: 'needs_review';
}>;

type Source = Readonly<{
  file: string;
  sentence_index: number;
  token_index: number;
  sentence_start: number;
  sentence_end: number;
}>;

type DraftExample = Readonly<{
  id: string;
  dataset: string;
  benchmark_split: 'calibration' | 'evaluation';
  source: Source;
  context: string;
  target: string;
  target_start: number;
  lookup_word: string;
  lemma: string;
  pos: string;
  number_of_candidates: number;
  number_of_runtime_candidates: number;
  candidates: readonly Candidate[];
  annotation_confidence: 'unreviewed';
  review_status: 'needs_annotation';
}>;

function hashLexiconWord(word: string): number {
  let hash = 2166136261;
  for (let index = 0; index < word.length; index += 1) {
    hash ^= word.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function stableHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function benchmarkSplit(lemma: string): 'calibration' | 'evaluation' {
  const bucket = Number.parseInt(stableHash(`split:${lemma}`).slice(0, 8), 16) % 10;
  return bucket < 4 ? 'evaluation' : 'calibration';
}

function candidateEntries(entry: LexiconEntry): readonly Candidate[] {
  let originalRank = 0;
  return entry.senses.flatMap((sense) => sense.definitions.map((gloss, index) => ({
    sense_id: `${entry.word}.${sense.partOfSpeech}.${index + 1}`,
    part_of_speech: sense.partOfSpeech,
    gloss,
    original_rank: originalRank++,
    relevance: 'needs_review' as const,
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

function readableRange(text: string): Readonly<{ start: number; end: number }> {
  const startMarker = '*** START OF THE PROJECT GUTENBERG EBOOK';
  const endMarker = '*** END OF THE PROJECT GUTENBERG EBOOK';
  const markerStart = text.indexOf(startMarker);
  const markerEnd = text.indexOf(endMarker);
  if (markerStart < 0 && markerEnd < 0) return { start: 0, end: text.length };
  if (markerStart < 0 || markerEnd < 0 || markerEnd <= markerStart) {
    throw new Error('Found an incomplete or invalid Project Gutenberg content boundary');
  }
  const contentStart = text.indexOf('\n', markerStart);
  if (contentStart < 0) throw new Error('Project Gutenberg start marker has no trailing newline');
  return { start: contentStart + 1, end: markerEnd };
}

async function oldSourceKeys(): Promise<ReadonlySet<string>> {
  const contents = await fs.readFile(OLD_DRAFT, 'utf8');
  return new Set(contents.split(/\r?\n/).filter(Boolean).map((line) => {
    const record = JSON.parse(line) as { source: Source };
    return `${record.source.file}:${record.source.sentence_index}:${record.source.token_index}`;
  }));
}

async function main(): Promise<void> {
  const [lemmaMapText, vocabularyText, excludedSources] = await Promise.all([
    fs.readFile(path.join(ROOT, 'data/lemma_dict.json'), 'utf8'),
    fs.readFile(path.join(ROOT, 'data/words.csv'), 'utf8'),
    oldSourceKeys(),
  ]);
  const lemmaMap = JSON.parse(lemmaMapText) as Readonly<Record<string, string>>;
  const vocabulary = parseVocabulary(vocabularyText);
  const bucketCache = new Map<number, readonly LexiconEntry[]>();
  const entryCache = new Map<string, LexiconEntry | null>();

  async function lookup(word: string): Promise<LexiconEntry | null> {
    const normalized = word.toLowerCase();
    if (entryCache.has(normalized)) return entryCache.get(normalized) ?? null;
    const bucket = hashLexiconWord(normalized) % 1024;
    let payload = bucketCache.get(bucket);
    if (!payload) {
      const bucketPath = path.join(ROOT, 'data/lexicon', `${String(bucket).padStart(4, '0')}.json`);
      payload = JSON.parse(await fs.readFile(bucketPath, 'utf8')) as readonly LexiconEntry[];
      bucketCache.set(bucket, payload);
    }
    const entry = payload.find((candidate) => candidate.word === normalized) ?? null;
    entryCache.set(normalized, entry);
    return entry;
  }

  const eligible: DraftExample[] = [];
  const contextKeysByLemma = new Map<string, Set<string>>();
  for (const fileName of BOOKS) {
    const text = await fs.readFile(path.join(ROOT, 'data', fileName), 'utf8');
    const readable = readableRange(text);
    const sentenceSpans = splitSentenceSpans(text);
    for (let sentenceIndex = 0; sentenceIndex < sentenceSpans.length; sentenceIndex += 1) {
      const span = sentenceSpans[sentenceIndex];
      if (span.start < readable.start || span.end > readable.end) continue;
      const context = span.text.replace(/\s+/g, ' ').trim();
      if (context.length > MAX_CONTEXT_CHARS) continue;
      const terms = tagSentenceTerms(context, nlp as never);
      const starts = taggedTermStarts(context, terms);
      const deinflected = contextualDeinflectTaggedTerms(
        terms, lemmaMap, vocabulary, new Set<string>(), false, nlp as never,
      );
      for (let tokenIndex = 0; tokenIndex < terms.length; tokenIndex += 1) {
        const term = terms[tokenIndex];
        const lemma = deinflected.tokens[tokenIndex];
        const pos = deinflected.partsOfSpeech[tokenIndex];
        if (!lemma || !pos || !OPEN_CLASS_POS.has(pos)) continue;
        const source: Source = {
          file: `data/${fileName}`,
          sentence_index: sentenceIndex,
          token_index: tokenIndex,
          sentence_start: span.start,
          sentence_end: span.end,
        };
        const sourceKey = `${source.file}:${sentenceIndex}:${tokenIndex}`;
        if (excludedSources.has(sourceKey)) continue;
        const contextKey = normalizedContextKey(context);
        const seenContexts = contextKeysByLemma.get(lemma) ?? new Set<string>();
        if (seenContexts.has(contextKey)) continue;

        const displayed = term.normalized;
        const entry = (displayed !== lemma ? await lookup(displayed) : null) ?? await lookup(lemma);
        if (!entry) continue;
        const candidates = candidateEntries(entry);
        const runtimeCandidates = candidates.filter((candidate) => candidate.part_of_speech === pos);
        if (
          runtimeCandidates.length < MIN_RUNTIME_CANDIDATES
          || runtimeCandidates.length > MAX_RUNTIME_CANDIDATES
        ) continue;

        eligible.push({
          id: `reader-filter-dev-v1-${path.parse(fileName).name}-${sentenceIndex}-${tokenIndex}`,
          dataset: DATASET,
          benchmark_split: benchmarkSplit(lemma),
          source,
          context,
          target: term.raw,
          target_start: starts[tokenIndex],
          lookup_word: entry.word,
          lemma,
          pos,
          number_of_candidates: candidates.length,
          number_of_runtime_candidates: runtimeCandidates.length,
          candidates,
          annotation_confidence: 'unreviewed',
          review_status: 'needs_annotation',
        });
        seenContexts.add(contextKey);
        contextKeysByLemma.set(lemma, seenContexts);
      }
    }
  }

  eligible.sort((left, right) => stableHash(left.id).localeCompare(stableHash(right.id)));
  const countByLemma = new Map<string, number>();
  const selected: DraftExample[] = [];
  for (const example of eligible) {
    if ((countByLemma.get(example.lemma) ?? 0) >= MAX_PER_LEMMA) continue;
    selected.push(example);
    countByLemma.set(example.lemma, (countByLemma.get(example.lemma) ?? 0) + 1);
    if (selected.length >= TARGET_EXAMPLES) break;
  }
  selected.sort((left, right) => left.id.localeCompare(right.id));
  await fs.writeFile(OUTPUT, `${selected.map((example) => JSON.stringify(example)).join('\n')}\n`, 'utf8');

  const sourceCounts = Object.fromEntries(BOOKS.map((book) => [
    book,
    selected.filter((example) => example.source.file === `data/${book}`).length,
  ]));
  const splitCounts = {
    calibration: selected.filter((example) => example.benchmark_split === 'calibration').length,
    evaluation: selected.filter((example) => example.benchmark_split === 'evaluation').length,
  };
  console.log(JSON.stringify({
    output: path.relative(ROOT, OUTPUT),
    eligible: eligible.length,
    selected: selected.length,
    lemmas: new Set(selected.map((example) => example.lemma)).size,
    sources: sourceCounts,
    splits: splitCounts,
    runtime_candidates: {
      minimum: Math.min(...selected.map((example) => example.number_of_runtime_candidates)),
      maximum: Math.max(...selected.map((example) => example.number_of_runtime_candidates)),
      mean: selected.reduce((sum, example) => sum + example.number_of_runtime_candidates, 0) / selected.length,
    },
  }, null, 2));
}

await main();
