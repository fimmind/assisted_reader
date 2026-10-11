import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateKnownWordCount } from '../src/core/model.js';
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
