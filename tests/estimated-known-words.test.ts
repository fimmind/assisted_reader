import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateKnownWordCount, estimateTheta } from '../src/core/model.js';
import { sigmoid } from '../src/core/math.js';
import { selectAdaptiveBatchWords } from '../src/core/quiz.js';
import type { UserProfile, VocabularyModel } from '../src/core/types.js';

const model: VocabularyModel = {
  modelKey: 'test',
  modelName: 'Test',
  words: ['first', 'second'],
  accuracy: [0.2, 0.8],
  difficulties: [-Math.log(0.2 / 0.8), -Math.log(0.8 / 0.2)],
  wordToIdx: new Map([['first', 0], ['second', 1]]),
  candidatePool: ['first', 'second'],
  candidatePositions: new Map([['first', 0], ['second', 1]]),
};

const profile: UserProfile = { id: 'test', name: 'Test', observations: {}, createdAt: '2026-01-01' };

test('estimated known words sums model probabilities and honors explicit answers', () => {
  assert.ok(Math.abs(estimateKnownWordCount(model, profile) - 1) < 1e-10);
  assert.equal(estimateKnownWordCount(model, {
    ...profile, observations: { first: 1, second: 0 },
  }), 1);
});

test('ability estimation converges for uniformly surprising answers', () => {
  const words = Array.from({ length: 20 }, (_, index) => `item-${index}`);
  const makeModel = (accuracy: number): VocabularyModel => {
    const difficulty = -Math.log(accuracy / (1 - accuracy));
    return {
      modelKey: 'extreme-response-test',
      modelName: 'Extreme response test',
      words,
      accuracy: words.map(() => accuracy),
      difficulties: words.map(() => difficulty),
      wordToIdx: new Map(words.map((word, index) => [word, index])),
      candidatePool: words,
      candidatePositions: new Map(words.map((word, index) => [word, index])),
    };
  };
  const solveIndependently = (difficulty: number, label: 0 | 1): number => {
    let lower = -100;
    let upper = 100;
    for (let step = 0; step < 200; step += 1) {
      const theta = (lower + upper) / 2;
      const gradient = words.length * (label - sigmoid(theta - difficulty)) - theta / 25;
      if (gradient > 0) {
        lower = theta;
      } else {
        upper = theta;
      }
    }
    return (lower + upper) / 2;
  };

  const easyModel = makeModel(0.96);
  const surprisingUnknown = { ...profile, observations: Object.fromEntries(words.map((word) => [word, 0 as const])) };
  const easyDifficulty = easyModel.difficulties[0];
  const easyTheta = estimateTheta(easyModel, surprisingUnknown);
  assert.ok(easyDifficulty !== undefined);
  assert.ok(Math.abs(easyTheta - solveIndependently(easyDifficulty, 0)) < 1e-7);

  const hardModel = makeModel(0.04);
  const surprisingKnown = { ...profile, observations: Object.fromEntries(words.map((word) => [word, 1 as const])) };
  const hardDifficulty = hardModel.difficulties[0];
  const hardTheta = estimateTheta(hardModel, surprisingKnown);
  assert.ok(hardDifficulty !== undefined);
  assert.ok(Math.abs(hardTheta - solveIndependently(hardDifficulty, 1)) < 1e-7);
});

test('adaptive quiz keeps seeded order while removing each selected candidate', () => {
  const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  const quizModel: VocabularyModel = {
    modelKey: 'seeded-quiz-test',
    modelName: 'Seeded quiz test',
    words,
    accuracy: words.map(() => 0.5),
    difficulties: words.map(() => 0),
    wordToIdx: new Map(words.map((word, index) => [word, index])),
    candidatePool: words,
    candidatePositions: new Map(words.map((word, index) => [word, index])),
  };

  assert.deepEqual(selectAdaptiveBatchWords(quizModel, profile, [], 42, 3), [
    'alpha', 'beta', 'delta',
  ]);
  assert.deepEqual(selectAdaptiveBatchWords(quizModel, profile, ['alpha'], 42, 2), [
    'beta', 'gamma',
  ]);
});
