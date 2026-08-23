import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { ChevronLeft, Undo2 } from 'lucide-react';
import type { CardItemInteraction, CardResponse } from '@/core/card-session';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';

interface CardSessionScreenProps {
  title: string;
  position: number;
  total: number;
  interaction: CardItemInteraction;
  frontContent: ReactNode;
  revealContent: ReactNode;
  canUndo: boolean;
  errorMessage: string;
  onExit: () => void;
  onReveal: () => void;
  onRespond: (response: CardResponse) => void;
  onUndo: () => void;
}

function isFormControl(element: Element | null): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  );
}

export function CardSessionScreen({
  title,
  position,
  total,
  interaction,
  frontContent,
  revealContent,
  canUndo,
  errorMessage,
  onExit,
  onReveal,
  onRespond,
  onUndo,
}: CardSessionScreenProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isFormControl(document.activeElement)) {
        return;
      }
      if (
        document.activeElement instanceof HTMLButtonElement &&
        (event.key === 'Enter' || event.key === ' ')
      ) {
        return;
      }
      if (!interaction.revealed) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onReveal();
        }
        return;
      }
      const respond = (response: CardResponse): void => {
        event.preventDefault();
        onRespond(response);
      };
      if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'd') {
        respond('unknown');
      } else if (
        event.key === 'ArrowRight' ||
        event.key.toLowerCase() === 'k'
      ) {
        respond('known');
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [interaction.revealed, onRespond, onReveal]);

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onExit();
      }}
    >
      <DialogContent className="inset-0 left-0 top-0 flex h-dvh max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-y-auto border-0 p-0 shadow-none sm:rounded-none [&>button]:hidden">
        <header className="border-b border-border bg-background/95">
          <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-4 sm:px-6">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 gap-2 text-muted-foreground"
              onClick={onExit}
            >
              <ChevronLeft size={18} />
              <span>Reader</span>
            </Button>
            <DialogTitle className="text-sm font-medium">{title}</DialogTitle>
            <DialogDescription className="sr-only">
              Classify the word, reveal its contextual meaning, then confirm
              your response.
            </DialogDescription>
            <Button
              variant="ghost"
              size="sm"
              className="-mr-2 gap-2 text-muted-foreground"
              onClick={onUndo}
              disabled={!canUndo}
            >
              <Undo2 size={16} />
              <span className="hidden sm:inline">Undo</span>
            </Button>
          </div>
        </header>

        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-5 sm:px-6 sm:py-8">
          <div
            className="mb-8 space-y-2"
            aria-label={`Card ${position + 1} of ${total}`}
          >
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {position + 1} of {total}
              </span>
              <span>
                {Math.round(
                  ((position + (interaction.revealed ? 0.5 : 0)) / total) * 100,
                )}
                %
              </span>
            </div>
            <Progress value={(position / total) * 100} className="h-1" />
          </div>

          <div className="mx-auto flex w-full max-w-xl flex-1 flex-col border border-border bg-card shadow-sm">
            <div className="flex-1 px-5 py-7 sm:px-9 sm:py-9">
              {frontContent}
              {interaction.revealed && (
                <div className="mt-8 border-t border-border pt-7">
                  {revealContent}
                </div>
              )}
              {errorMessage.length > 0 && (
                <p role="alert" className="mt-5 text-sm text-destructive">
                  {errorMessage}
                </p>
              )}
            </div>

            <footer className="grid shrink-0 border-t border-border">
              {!interaction.revealed ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-14 w-full rounded-none border-0"
                  aria-keyshortcuts="Enter Space"
                  onClick={onReveal}
                >
                  Answer
                </Button>
              ) : (
                <div className="grid grid-cols-2">
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-14 rounded-none border-0 text-muted-foreground"
                    aria-keyshortcuts="D ArrowLeft"
                    onClick={() => onRespond('unknown')}
                  >
                    Didn’t recognize
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-14 rounded-none border-0 border-l border-border text-foreground"
                    aria-keyshortcuts="K ArrowRight"
                    onClick={() => onRespond('known')}
                  >
                    Recognized
                  </Button>
                </div>
              )}
            </footer>
          </div>
        </main>
      </DialogContent>
    </Dialog>
  );
}
