import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DEFAULT_QUIZ_BATCH_SIZE, DEFAULT_QUIZ_TOTAL_WORDS } from '@/core/constants';

interface VocabularyTestInvitationProps {
  open: boolean;
  onDismiss: () => void;
  onTakeTest: () => void;
}

export function VocabularyTestInvitation({ open, onDismiss, onTakeTest }: VocabularyTestInvitationProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) onDismiss();
    }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl">Make Easeword fit your vocabulary</DialogTitle>
          <DialogDescription>
            Take a vocabulary test so Easeword can estimate which words you know and show definitions where you need them.
          </DialogDescription>
        </DialogHeader>
        <p className="mt-3 text-sm text-muted-foreground">
          {DEFAULT_QUIZ_TOTAL_WORDS} words · {Math.ceil(DEFAULT_QUIZ_TOTAL_WORDS / DEFAULT_QUIZ_BATCH_SIZE)} short batches
        </p>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={onDismiss}>Start reading first</Button>
          <Button onClick={onTakeTest}>Take vocabulary test</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
