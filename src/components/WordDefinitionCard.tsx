import { Check, X } from 'lucide-react';
import type { LexiconEntry } from '@/core/types';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

interface WordDefinitionCardProps {
  definition: LexiconEntry;
  onMarkKnown?: () => void;
  onMarkUnknown?: () => void;
  compact?: boolean;
  isMarkedKnown?: boolean;
  isMarkedUnknown?: boolean;
  pronunciationVariant?: 'US' | 'UK';
}

function resolveIpa(definition: LexiconEntry, pronunciationVariant: 'US' | 'UK'): string {
  if (pronunciationVariant === 'UK') {
    if (typeof definition.ipaUk === 'string' && definition.ipaUk.trim().length > 0) {
      return definition.ipaUk.trim();
    }
    if (typeof definition.ipaUs === 'string' && definition.ipaUs.trim().length > 0) {
      return definition.ipaUs.trim();
    }
  } else {
    if (typeof definition.ipaUs === 'string' && definition.ipaUs.trim().length > 0) {
      return definition.ipaUs.trim();
    }
    if (typeof definition.ipaUk === 'string' && definition.ipaUk.trim().length > 0) {
      return definition.ipaUk.trim();
    }
  }
  return definition.ipa.trim();
}

function resolveDefinitions(definition: LexiconEntry): string[] {
  if (Array.isArray(definition.definitions)) {
    const sanitized = definition.definitions
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (sanitized.length > 0) {
      return sanitized;
    }
  }
  const fallback = definition.definition.trim();
  if (fallback.length > 0) {
    return [fallback];
  }
  return ['Definition unavailable in this build.'];
}

export function WordDefinitionCard({
  definition,
  onMarkKnown,
  onMarkUnknown,
  compact = false,
  isMarkedKnown = false,
  isMarkedUnknown = false,
  pronunciationVariant = 'US',
}: WordDefinitionCardProps) {
  const ipaText = resolveIpa(definition, pronunciationVariant);
  const definitionLines = resolveDefinitions(definition);

  if (compact) {
    return (
      <div className="inline-flex flex-col bg-popover border border-border rounded-md shadow-sm px-3 pt-2.5 pb-3 mx-2 my-1 max-w-[250px] align-middle">
        <div className="flex items-center justify-between gap-3 mb-1">
          <div className="flex items-baseline gap-2">
            <span className="font-serif font-medium text-[1.1em]">{definition.word}</span>
            {ipaText.length > 0 && (
              <span className="text-xs text-muted-foreground italic">{ipaText}</span>
            )}
          </div>
          <div className="flex gap-1">
            <button
              onClick={onMarkKnown}
              className={cn(
                'p-1 text-muted-foreground hover:text-primary transition-colors rounded-sm hover:bg-muted',
                isMarkedKnown && 'bg-primary/15 text-primary hover:text-primary',
              )}
              aria-label="Mark as known"
            >
              <Check size={14} />
            </button>
            <button
              onClick={onMarkUnknown}
              className={cn(
                'p-1 text-muted-foreground hover:text-destructive transition-colors rounded-sm hover:bg-muted',
                isMarkedUnknown && 'bg-destructive/15 text-destructive hover:text-destructive',
              )}
              aria-label="Mark as unknown"
            >
              <X size={14} />
            </button>
          </div>
        </div>
        {definitionLines.length === 1 ? (
          <p className="text-sm text-foreground/80 leading-snug">{definitionLines[0]}</p>
        ) : (
          <ol className="text-sm text-foreground/80 leading-snug list-decimal pl-4 space-y-1">
            {definitionLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        )}
      </div>
    );
  }

  return (
    <div className="bg-popover rounded-lg p-5 w-[300px]">
      <div className="flex justify-between items-start mb-3">
        <div>
          <h3 className="font-serif text-2xl font-medium text-foreground">{definition.word}</h3>
          {ipaText.length > 0 && (
            <p className="text-muted-foreground italic mt-1">{ipaText}</p>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={onMarkKnown}
            className={cn(
              'h-8 w-8 rounded-full hover:bg-primary/10 hover:text-primary',
              isMarkedKnown && 'bg-primary/15 text-primary hover:text-primary',
            )}
            aria-label="Mark as known"
          >
            <Check size={18} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onMarkUnknown}
            className={cn(
              'h-8 w-8 rounded-full hover:bg-destructive/10 hover:text-destructive',
              isMarkedUnknown && 'bg-destructive/15 text-destructive hover:text-destructive',
            )}
            aria-label="Mark as unknown"
          >
            <X size={18} />
          </Button>
        </div>
      </div>
      {definitionLines.length === 1 ? (
        <p className="text-foreground/90 text-sm leading-relaxed">{definitionLines[0]}</p>
      ) : (
        <ol className="text-foreground/90 text-sm leading-relaxed list-decimal pl-5 space-y-1">
          {definitionLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
