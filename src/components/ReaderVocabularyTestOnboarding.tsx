import { useState } from 'react';
import type { ReactElement } from 'react';
import { QuizModal } from '@/components/QuizModal';
import { VocabularyTestInvitation } from '@/components/VocabularyTestInvitation';
import { DEFAULT_QUIZ_TOTAL_WORDS } from '@/core/constants';
import { deferVocabularyTest } from '@/core/profile-store';
import { useActiveProfile } from '@/hooks/useActiveProfile';

interface ReaderVocabularyTestOnboardingProps {
  readerReady: boolean;
}

export function ReaderVocabularyTestOnboarding({ readerReady }: ReaderVocabularyTestOnboardingProps): ReactElement {
  const profile = useActiveProfile();
  const [quizOpen, setQuizOpen] = useState(false);
  const [dismissedProfileIds, setDismissedProfileIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const needsWordHistory = Object.keys(profile.observations).length < DEFAULT_QUIZ_TOTAL_WORDS;

  const dismissProfileInvitation = (profileId: string): void => {
    setDismissedProfileIds((previous) => new Set([...previous, profileId]));
  };

  const dismissInvitation = (): void => {
    if (profile.vocabularyTestStatus !== 'completed') deferVocabularyTest(profile.id);
    dismissProfileInvitation(profile.id);
  };

  return (
    <>
      <VocabularyTestInvitation
        open={readerReady && needsWordHistory && !dismissedProfileIds.has(profile.id) && !quizOpen}
        onDismiss={dismissInvitation}
        onTakeTest={() => {
          dismissInvitation();
          setQuizOpen(true);
        }}
      />
      <QuizModal
        key={profile.id}
        open={quizOpen}
        onOpenChange={setQuizOpen}
        onComplete={dismissProfileInvitation}
      />
    </>
  );
}
