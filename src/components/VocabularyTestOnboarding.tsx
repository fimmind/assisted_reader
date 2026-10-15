import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { QuizModal } from '@/components/QuizModal';
import { VocabularyTestInvitation } from '@/components/VocabularyTestInvitation';
import { deferVocabularyTest } from '@/core/profile-store';
import { useActiveProfile } from '@/hooks/useActiveProfile';

interface VocabularyTestOnboardingProps {
  quizOpen: boolean;
  onQuizOpenChange: (open: boolean) => void;
}

export function VocabularyTestOnboarding({ quizOpen, onQuizOpenChange }: VocabularyTestOnboardingProps): ReactElement {
  const profile = useActiveProfile();
  const [completedProfileId, setCompletedProfileId] = useState<string | null>(null);

  useEffect(() => {
    setCompletedProfileId(null);
  }, [profile.id]);

  return (
    <>
      {profile.vocabularyTestStatus === 'completed' && completedProfileId === profile.id && (
        <p role="status" className="mb-6 text-sm text-muted-foreground">
          Vocabulary test complete. Your vocabulary assistance is now personalized.
        </p>
      )}
      <VocabularyTestInvitation
        open={profile.vocabularyTestStatus === 'pending' && !quizOpen}
        onDismiss={() => deferVocabularyTest(profile.id)}
        onTakeTest={() => {
          deferVocabularyTest(profile.id);
          onQuizOpenChange(true);
        }}
      />
      <QuizModal
        key={profile.id}
        open={quizOpen}
        onOpenChange={onQuizOpenChange}
        onComplete={setCompletedProfileId}
      />
    </>
  );
}

export function VocabularyTestReminder(): ReactElement | null {
  const profile = useActiveProfile();
  if (profile.vocabularyTestStatus === 'pending' || profile.vocabularyTestStatus === 'completed') {
    return null;
  }

  return (
    <p className="mb-6 text-sm text-muted-foreground">Your vocabulary level hasn’t been estimated yet! You'd better take a Quiz...</p>
  );
}
