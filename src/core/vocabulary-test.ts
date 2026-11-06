import type { UserProfile } from './types';

export function shouldShowVocabularyTestReminder(
  profile: Pick<UserProfile, 'observations' | 'vocabularyTestStatus'>,
): boolean {
  if (Object.keys(profile.observations).length > 0) {
    return false;
  }

  return profile.vocabularyTestStatus !== 'pending' && profile.vocabularyTestStatus !== 'completed';
}
