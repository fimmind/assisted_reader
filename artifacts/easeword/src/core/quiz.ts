import { ADAPTIVE_TEMPERATURE, ADAPTIVE_TOP_K } from './constants';
import { estimateTheta, predictUncertainty } from './model';
import type { UserProfile, VocabularyModel } from './types';

interface RngState {
  state: number;
}

function createRng(seed: number): RngState {
  return { state: seed >>> 0 };
}

function nextRandom(rng: RngState): number {
  rng.state = (Math.imul(1664525, rng.state) + 1013904223) >>> 0;
  return rng.state / 4294967296;
}

function stableSortByUncertainty(candidates: string[], uncertainties: Map<string, number>, positions: Map<string, number>): string[] {
  const sorted = [...candidates];
  sorted.sort((left, right) => {
    const uncertaintyDelta = (uncertainties.get(right) ?? 0) - (uncertainties.get(left) ?? 0);
    if (uncertaintyDelta !== 0) {
      return uncertaintyDelta;
    }
    const leftPos = positions.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightPos = positions.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftPos - rightPos;
  });
  return sorted;
}

function sampleTopK(candidates: string[], uncertainties: Map<string, number>, rng: RngState): string {
  const topKSize = Math.min(ADAPTIVE_TOP_K, candidates.length);
  const topCandidates = candidates.slice(0, topKSize);
  const logits = topCandidates.map((word) => (uncertainties.get(word) ?? 0) / ADAPTIVE_TEMPERATURE);

  const maxLogit = Math.max(...logits);
  const weights = logits.map((logit) => Math.exp(Math.max(-60, Math.min(60, logit - maxLogit))));
  const sum = weights.reduce((accumulator, value) => accumulator + value, 0);
  const safeDenominator = sum <= 1e-12 ? 1e-12 : sum;

  const randomValue = nextRandom(rng);
  let cumulative = 0;
  for (let index = 0; index < topCandidates.length; index += 1) {
    cumulative += weights[index] / safeDenominator;
    if (randomValue <= cumulative || index === topCandidates.length - 1) {
      return topCandidates[index];
    }
  }

  return topCandidates[topCandidates.length - 1];
}

export function selectAdaptiveBatchWords(
  model: VocabularyModel,
  profile: UserProfile,
  alreadyQueried: string[],
  seed: number,
  count: number,
): string[] {
  const queriedSet = new Set<string>(alreadyQueried.map((word) => word.toLowerCase()));
  const rng = createRng(seed);
  const output: string[] = [];

  for (let i = 0; i < count; i += 1) {
    const theta = estimateTheta(model, profile);
    const pool = model.candidatePool.filter((word) => {
      const normalized = word.toLowerCase();
      return !queriedSet.has(normalized);
    });

    if (pool.length === 0) {
      break;
    }

    const uncertainties = new Map<string, number>();
    for (const word of pool) {
      const uncertainty = predictUncertainty(model, profile, theta, word.toLowerCase());
      uncertainties.set(word, uncertainty);
    }

    const ranked = stableSortByUncertainty(pool, uncertainties, model.candidatePositions);
    const selected = sampleTopK(ranked, uncertainties, rng);
    output.push(selected);
    queriedSet.add(selected.toLowerCase());
  }

  return output;
}
