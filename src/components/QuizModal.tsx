import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { getActiveProfile, loadProfileState, upsertObservationsBatch } from '@/core/profile-store';
import { loadVocabularyModel } from '@/core/model';
import { selectAdaptiveBatchWords } from '@/core/quiz';
import { parseInteger } from '@/core/math';

interface QuizModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ActiveQuiz {
  seed: number;
  totalWords: number;
  batchSize: number;
  currentBatch: number;
  queried: string[];
  currentWords: string[];
}

function getTotalBatches(totalWords: number, batchSize: number): number {
  const safeBatchSize = Math.max(1, batchSize);
  return Math.ceil(totalWords / safeBatchSize);
}

export function QuizModal({ open, onOpenChange }: QuizModalProps) {
  const [step, setStep] = useState<'setup' | 'quiz'>('setup');
  const [totalWords, setTotalWords] = useState(60);
  const [batchSize, setBatchSize] = useState(20);
  const [checkedWords, setCheckedWords] = useState<Set<string>>(new Set());
  const [activeQuiz, setActiveQuiz] = useState<ActiveQuiz | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>('');

  const resetQuizState = () => {
    setStep('setup');
    setCheckedWords(new Set());
    setActiveQuiz(null);
    setLoading(false);
    setErrorMessage('');
  };

  const startQuiz = async () => {
    const normalizedTotalWords = Math.max(1, totalWords);
    const normalizedBatchSize = Math.max(1, batchSize);
    setLoading(true);
    setErrorMessage('');

    try {
      const model = await loadVocabularyModel();
      const profileState = loadProfileState();
      const profile = getActiveProfile(profileState);
      const seed = Date.now() >>> 0;
      const initialCount = Math.min(normalizedBatchSize, normalizedTotalWords);
      const words = selectAdaptiveBatchWords(model, profile, [], seed, initialCount);
      if (words.length === 0) {
        throw new Error('No quiz candidates available for the current model state.');
      }

      setActiveQuiz({
        seed,
        totalWords: normalizedTotalWords,
        batchSize: normalizedBatchSize,
        currentBatch: 1,
        queried: words,
        currentWords: words,
      });
      setCheckedWords(new Set());
      setStep('quiz');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start quiz.';
      setErrorMessage(message);
    } finally {
      setLoading(false);
    }
  };

  const toggleWord = (word: string) => {
    setWordCheckedState(word, !checkedWords.has(word));
  };

  const setWordCheckedState = (word: string, isChecked: boolean) => {
    const next = new Set(checkedWords);
    if (isChecked) {
      next.add(word);
    } else {
      next.delete(word);
    }
    setCheckedWords(next);
  };

  const submitBatch = async () => {
    if (!activeQuiz) {
      return;
    }

    const observationUpdates: Record<string, 0 | 1> = {};
    for (const word of activeQuiz.currentWords) {
      const known = checkedWords.has(word);
      observationUpdates[word.toLowerCase()] = known ? 1 : 0;
    }
    upsertObservationsBatch(observationUpdates);

    const queriedCount = activeQuiz.queried.length;
    if (queriedCount >= activeQuiz.totalWords) {
      resetQuizState();
      onOpenChange(false);
      return;
    }

    setLoading(true);
    setErrorMessage('');

    try {
      const model = await loadVocabularyModel();
      const profileState = loadProfileState();
      const profile = getActiveProfile(profileState);
      const remaining = activeQuiz.totalWords - queriedCount;
      const nextCount = Math.min(activeQuiz.batchSize, remaining);
      const nextSeed = (activeQuiz.seed + activeQuiz.currentBatch) >>> 0;
      const nextWords = selectAdaptiveBatchWords(model, profile, activeQuiz.queried, nextSeed, nextCount);

      if (nextWords.length === 0) {
        resetQuizState();
        onOpenChange(false);
        return;
      }

      setActiveQuiz({
        ...activeQuiz,
        currentBatch: activeQuiz.currentBatch + 1,
        queried: [...activeQuiz.queried, ...nextWords],
        currentWords: nextWords,
      });
      setCheckedWords(new Set());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load next quiz batch.';
      setErrorMessage(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          resetQuizState();
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className={step === 'quiz' ? 'sm:max-w-[720px]' : 'sm:max-w-[500px]'}>
        {step === 'setup' ? (
          <>
            <DialogHeader>
              <DialogTitle className="font-serif text-2xl">Vocabulary Quiz</DialogTitle>
              <DialogDescription>Test your current vocabulary knowledge.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-6 py-4">
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="total-words" className="text-right">Total words</Label>
                <Input
                  id="total-words"
                  type="number"
                  value={totalWords}
                  onChange={(event) => setTotalWords(Math.max(1, parseInteger(event.target.value)))}
                  className="col-span-3"
                />
              </div>
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="batch-size" className="text-right">Batch size</Label>
                <Input
                  id="batch-size"
                  type="number"
                  value={batchSize}
                  onChange={(event) => setBatchSize(Math.max(1, parseInteger(event.target.value)))}
                  className="col-span-3"
                />
              </div>
              {errorMessage.length > 0 && (
                <p className="text-sm text-destructive">{errorMessage}</p>
              )}
            </div>
            <DialogFooter>
              <Button
                onClick={startQuiz}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
                disabled={loading}
              >
                {loading ? 'Preparing...' : 'Take Quiz'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="font-serif text-2xl">
                Batch {activeQuiz?.currentBatch ?? 1} of {getTotalBatches(activeQuiz?.totalWords ?? totalWords, activeQuiz?.batchSize ?? batchSize)}
              </DialogTitle>
            </DialogHeader>
            <div className="py-4">
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {(activeQuiz?.currentWords ?? []).map((word) => (
                  <div
                    key={word}
                    className="flex items-center gap-2 p-2 rounded-md hover:bg-muted/50 transition-colors cursor-pointer"
                    onClick={() => toggleWord(word)}
                  >
                    <Checkbox
                      id={`quiz-word-${word}`}
                      checked={checkedWords.has(word)}
                      onClick={(event) => event.stopPropagation()}
                      onCheckedChange={(checked) => setWordCheckedState(word, checked === true)}
                      className="border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
                    />
                    <span className="text-sm font-serif font-medium leading-tight break-words">
                      {word}
                    </span>
                  </div>
                ))}
              </div>
              {errorMessage.length > 0 && (
                <p className="text-sm text-destructive mt-4">{errorMessage}</p>
              )}
            </div>
            <DialogFooter>
              <Button
                onClick={submitBatch}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
                disabled={loading}
              >
                {loading
                  ? 'Submitting...'
                  : (activeQuiz && activeQuiz.queried.length < activeQuiz.totalWords ? 'Submit batch' : 'Finish')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
