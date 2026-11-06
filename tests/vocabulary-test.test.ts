import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowVocabularyTestReminder } from '../src/core/vocabulary-test.js';
import type { UserProfile } from '../src/core/types.js';

function createProfile(
  observations: Record<string, 0 | 1>,
  vocabularyTestStatus: UserProfile['vocabularyTestStatus'],
): UserProfile {
  return {
    id: 'reader',
    name: 'Reader',
    observations,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...(vocabularyTestStatus === undefined ? {} : { vocabularyTestStatus }),
  };
}

test('vocabulary test reminder respects observations on legacy profiles', () => {
  const profile = createProfile({ familiar: 1 }, undefined);

  assert.equal(shouldShowVocabularyTestReminder(profile), false);
  assert.equal(profile.vocabularyTestStatus, undefined);
});

test('vocabulary test reminder is hidden for deferred profiles with observations', () => {
  const profile = createProfile({ familiar: 0 }, 'deferred');

  assert.equal(shouldShowVocabularyTestReminder(profile), false);
  assert.equal(profile.vocabularyTestStatus, 'deferred');
});

test('vocabulary test reminder remains visible for deferred profiles without observations', () => {
  const profile = createProfile({}, 'deferred');

  assert.equal(shouldShowVocabularyTestReminder(profile), true);
  assert.equal(profile.vocabularyTestStatus, 'deferred');
});

test('vocabulary test reminder remains hidden for pending profiles without observations', () => {
  const profile = createProfile({}, 'pending');

  assert.equal(shouldShowVocabularyTestReminder(profile), false);
  assert.equal(profile.vocabularyTestStatus, 'pending');
});
