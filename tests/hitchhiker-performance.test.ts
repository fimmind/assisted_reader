import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { calculateBookStatsFromLemmaHistogram } from '../src/core/reader-analysis.js';
import { clip01, logit } from '../src/core/math.js';
import type { ReaderSettings, UserProfile, VocabularyModel } from '../src/core/types.js';
import type { BookLemmaHistogram } from '../src/core/reader-analysis.js';

function parseCsvRow(line: string): string[] {
  const cells: string[] = [];
  let cursor = 0;
  let current = '';
  let inQuotes = false;

  while (cursor < line.length) {
    const char = line[cursor];
    if (char === '"') {
      const nextChar = line[cursor + 1];
      if (inQuotes && nextChar === '"') {
        current += '"';
        cursor += 2;
        continue;
      }
      inQuotes = !inQuotes;
      cursor += 1;
      continue;
    }
    if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      cursor += 1;
      continue;
    }
    current += char;
    cursor += 1;
  }

  cells.push(current);
  return cells;
}

function loadVocabularyModelFromCsv(): VocabularyModel {
  const rawCsv = fs.readFileSync('./data/words.csv', 'utf8');
  const lines = rawCsv.split(/\r?\n/);
  if (lines.length < 2) {
    throw new Error('Vocabulary CSV is empty or missing header.');
  }

  const header = parseCsvRow(lines[0]).map((cell) => cell.trim());
  const wordIndex = header.indexOf('word');
  const accuracyIndex = header.indexOf('accuracy');
  if (wordIndex < 0 || accuracyIndex < 0) {
    throw new Error('Vocabulary CSV must include word and accuracy columns.');
  }

  const words: string[] = [];
  const accuracy: number[] = [];
  const difficulties: number[] = [];
  const wordToIdx = new Map<string, number>();
  const candidatePositions = new Map<string, number>();

  for (let lineNumber = 2; lineNumber <= lines.length; lineNumber += 1) {
    const line = lines[lineNumber - 1];
    if (line.trim().length === 0) {
      continue;
    }
    const cells = parseCsvRow(line);
    const word = (cells[wordIndex] ?? '').trim().toLowerCase();
    const accuracyValue = Number(cells[accuracyIndex] ?? '');

    if (word.length === 0 || !Number.isFinite(accuracyValue) || wordToIdx.has(word)) {
      throw new Error(`Invalid vocabulary CSV row at line=${lineNumber}`);
    }

    const idx = words.length;
    words.push(word);
    accuracy.push(clip01(accuracyValue));
    difficulties.push(-logit(clip01(accuracyValue)));
    wordToIdx.set(word, idx);
    candidatePositions.set(word, idx);
  }

  return {
    modelKey: 'rasch_words_csv_v1',
    modelName: 'Basic Rasch from words.csv',
    words,
    accuracy,
    difficulties,
    wordToIdx,
    candidatePool: words,
    candidatePositions,
  };
}

function loadHitchhikerHistogram(): BookLemmaHistogram {
  const raw = fs.readFileSync('./data/seed-hitchhiker-lemma-histogram.json', 'utf8');
  return JSON.parse(raw) as BookLemmaHistogram;
}

test("Hitchhiker analysis fast path stays below 50ms", () => {
  const model = loadVocabularyModelFromCsv();
  const histogram = loadHitchhikerHistogram();
  const settings: ReaderSettings = {
    fontSize: 18,
    lineSpacing: 'Normal',
    fontChoice: 'Serif',
    pageWidth: 'Normal',
    maxWordsPerParagraph: 1,
    deduplicationRadius: 5,
    knowledgeThreshold: 0.5,
    englishVariant: 'US',
  };
  const profile: UserProfile = {
    id: 'performance-profile',
    name: 'Performance Profile',
    observations: {},
    createdAt: new Date().toISOString(),
  };

  calculateBookStatsFromLemmaHistogram(histogram, settings, model, profile);

  const runs = 25;
  let slowestMs = 0;
  for (let run = 0; run < runs; run += 1) {
    const startedAt = performance.now();
    const stats = calculateBookStatsFromLemmaHistogram(histogram, settings, model, profile);
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs > slowestMs) {
      slowestMs = elapsedMs;
    }
    assert.equal(Number.isFinite(stats.unknownTokenCount), true);
  }

  assert.equal(
    slowestMs < 50,
    true,
    `Expected Hitchhiker analysis below 50ms, observed slowest run ${slowestMs.toFixed(2)}ms`,
  );
});
