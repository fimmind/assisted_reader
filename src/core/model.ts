import type { UserProfile, VocabularyModel, VocabularyModelPayload } from './types';
import { clip01, logit, sigmoid } from './math';

const MODEL_URL = 'data/best_grouped_irt_model_model_data.json';

let modelPromise: Promise<VocabularyModel> | null = null;

function validatePayload(payload: VocabularyModelPayload): void {
  if (payload.words.length !== payload.accuracy.length) {
    throw new Error('Model payload invariant failed: words length must equal accuracy length.');
  }
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
      throw new Error(`Failed to load model payload: status=${response.status}`);
    }
    const payload = (await response.json()) as VocabularyModelPayload;
    validatePayload(payload);

    const difficulties = payload.accuracy.map((value) => -logit(clip01(value)));
    const wordToIdx = new Map<string, number>();
    payload.words.forEach((word, index) => {
      wordToIdx.set(word.toLowerCase(), index);
    });

    const rawPool = payload.adaptive_candidate_pool && payload.adaptive_candidate_pool.length > 0
      ? payload.adaptive_candidate_pool
      : payload.query_pool;

    const candidatePool = rawPool.filter((word) => wordToIdx.has(word.toLowerCase()));
    const candidatePositions = new Map<string, number>();
    candidatePool.forEach((word, index) => {
      candidatePositions.set(word, index);
      candidatePositions.set(word.toLowerCase(), index);
    });

    const model: VocabularyModel = {
      modelKey: payload.model_key,
      modelName: payload.model_name,
      words: payload.words,
      accuracy: payload.accuracy,
      difficulties,
      wordToIdx,
      candidatePool,
      candidatePositions,
    };

    return model;
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
