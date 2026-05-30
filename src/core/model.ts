import type { UserProfile, VocabularyModel } from './types';
import { clip01, logit, sigmoid } from './math';

const MODEL_URL = 'data/words.csv';
const MODEL_KEY = 'rasch_words_csv_v1';
const MODEL_NAME = 'Basic Rasch from words.csv';

let modelPromise: Promise<VocabularyModel> | null = null;

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

function parseVocabularyCsv(rawCsv: string): VocabularyModel {
  const lines = rawCsv.split(/\r?\n/);
  if (lines.length < 2) {
    throw new Error('Vocabulary CSV is empty or missing header.');
  }

  const header = parseCsvRow(lines[0]).map((cell) => cell.trim());
  const wordIndex = header.indexOf('word');
  const accuracyIndex = header.indexOf('accuracy');
  if (wordIndex < 0 || accuracyIndex < 0) {
    throw new Error('Vocabulary CSV must include "word" and "accuracy" columns.');
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
    const rawWord = cells[wordIndex] ?? '';
    const normalizedWord = rawWord.trim().toLowerCase();
    if (normalizedWord.length === 0) {
      throw new Error(`Vocabulary CSV has empty word value at line=${lineNumber}.`);
    }

    if (wordToIdx.has(normalizedWord)) {
      throw new Error(`Vocabulary CSV has duplicate word value="${normalizedWord}" at line=${lineNumber}.`);
    }

    const accuracyRaw = cells[accuracyIndex] ?? '';
    const accuracyValue = Number(accuracyRaw);
    if (!Number.isFinite(accuracyValue)) {
      throw new Error(`Vocabulary CSV has invalid accuracy value="${accuracyRaw}" at line=${lineNumber}.`);
    }

    const clippedAccuracy = clip01(accuracyValue);
    const difficulty = -logit(clippedAccuracy);
    const idx = words.length;

    words.push(normalizedWord);
    accuracy.push(clippedAccuracy);
    difficulties.push(difficulty);
    wordToIdx.set(normalizedWord, idx);
    candidatePositions.set(normalizedWord, idx);
  }

  if (words.length === 0) {
    throw new Error('Vocabulary CSV has no usable rows.');
  }

  return {
    modelKey: MODEL_KEY,
    modelName: MODEL_NAME,
    words,
    accuracy,
    difficulties,
    wordToIdx,
    candidatePool: words,
    candidatePositions,
  };
}

export function getModelUrl(): string {
  return `${import.meta.env.BASE_URL}${MODEL_URL}`;
}

export async function loadVocabularyModel(): Promise<VocabularyModel> {
  if (modelPromise) {
    return modelPromise;
  }

  modelPromise = (async () => {
    const response = await fetch(getModelUrl());
    if (!response.ok) {
      throw new Error(`Failed to load vocabulary CSV: status=${response.status}`);
    }
    const rawCsv = await response.text();
    return parseVocabularyCsv(rawCsv);
  })();

  return modelPromise;
}

export function estimateTheta(model: VocabularyModel, profile: UserProfile): number {
  const priorVariance = 25.0;
  let theta = 0;
  const observedEntries = Object.entries(profile.observations);
  if (observedEntries.length === 0) {
    return theta;
  }

  const observations: Array<{ idx: number; label: 0 | 1 }> = [];
  for (const [word, label] of observedEntries) {
    const idx = model.wordToIdx.get(word.toLowerCase());
    if (idx === undefined) {
      continue;
    }
    observations.push({ idx, label });
  }

  if (observations.length === 0) {
    return theta;
  }

  for (let step = 0; step < 20; step += 1) {
    let grad = 0;
    let hess = 0;

    for (const observation of observations) {
      const difficulty = model.difficulties[observation.idx];
      const probability = sigmoid(theta - difficulty);
      grad += observation.label - probability;
      hess -= probability * (1 - probability);
    }

    grad -= theta / priorVariance;
    hess -= 1 / priorVariance;

    if (Math.abs(hess) < 1e-8) {
      break;
    }

    const nextTheta = theta - grad / hess;
    if (!Number.isFinite(nextTheta)) {
      break;
    }
    theta = nextTheta;
  }

  return theta;
}

export function predictKnownProbability(model: VocabularyModel, profile: UserProfile, theta: number, lemma: string): number {
  const observed = profile.observations[lemma];
  if (observed === 1) {
    return 1;
  }
  if (observed === 0) {
    return 0;
  }

  const idx = model.wordToIdx.get(lemma.toLowerCase());
  if (idx === undefined) {
    return 1;
  }

  return sigmoid(theta - model.difficulties[idx]);
}

export function predictUncertainty(model: VocabularyModel, profile: UserProfile, theta: number, lemma: string): number {
  const probability = predictKnownProbability(model, profile, theta, lemma);
  return probability * (1 - probability);
}
