import type { ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import { HYPHENATED_WORD_RE, WORD_RE } from '@/core/constants';
import { resolveLexiconPronunciations } from '@/core/lexicon';
import type { LexiconEntry, PartOfSpeech } from '@/core/types';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';

export interface DefinitionWordClick {
  element: HTMLElement;
  definitionText: string;
  start: number;
  end: number;
}

export interface DefinitionTextSelection {
  definitionText: string;
  end: number;
  start: number;
}

interface WordDefinitionCardProps {
  definition: LexiconEntry;
  activeDefinitionSelection?: DefinitionTextSelection;
  fontSize: number;
  onDefinitionWordClick: (click: DefinitionWordClick) => void;
  onMarkKnown?: () => void;
  onMarkUnknown?: () => void;
  compact?: boolean;
  isMarkedKnown?: boolean;
  isMarkedUnknown?: boolean;
  pronunciationVariant?: 'US' | 'UK';
  definitionStatus?: 'loading' | 'ready' | 'error';
}

function resolveDefinitionCardFontSize(readerFontSize: number): number {
  const scaledFontSize = readerFontSize * 0.8;
  return Math.min(20, Math.max(12, scaledFontSize));
}

function formatPartOfSpeech(partOfSpeech: PartOfSpeech): string {
  return partOfSpeech
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function renderClickableDefinitionRange(
  definitionText: string,
  rangeStart: number,
  rangeEnd: number,
  activeDefinitionSelection: DefinitionTextSelection | undefined,
  enableWordHover: boolean,
  onDefinitionWordClick: (click: DefinitionWordClick) => void,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const matcher = new RegExp(WORD_RE.source, WORD_RE.flags);
  const rangeText = definitionText.slice(rangeStart, rangeEnd);
  let cursor = rangeStart;
  let match = matcher.exec(rangeText);

  while (match) {
    const word = match[0];
    const start = rangeStart + match.index;
    const end = start + word.length;
    if (start > cursor) {
      nodes.push(definitionText.slice(cursor, start));
    }
    const wordIsActive = activeDefinitionSelection?.definitionText === definitionText
      && activeDefinitionSelection.start === start
      && activeDefinitionSelection.end === end;
    nodes.push(
      <button
        key={`${start}-${end}`}
        type="button"
        data-word-popup-trigger="true"
        className={cn(
          'cursor-pointer rounded-[2px] -mx-px px-px text-inherit focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          enableWordHover && 'hover:bg-primary/10',
          wordIsActive && 'bg-primary/15',
        )}
        aria-label={`Look up ${word}`}
        onClick={(event) => onDefinitionWordClick({
          element: event.currentTarget,
          definitionText,
          start,
          end,
        })}
      >
        {word}
      </button>,
    );
    cursor = end;
    match = matcher.exec(rangeText);
  }

  if (cursor < rangeEnd) {
    nodes.push(definitionText.slice(cursor, rangeEnd));
  }
  return nodes;
}

function isValidDefinitionSelection(
  definitionText: string,
  selection: DefinitionTextSelection | undefined,
): selection is DefinitionTextSelection {
  return selection?.definitionText === definitionText
    && selection.start >= 0
    && selection.end > selection.start
    && selection.end <= definitionText.length;
}

function renderClickableDefinition(
  definitionText: string,
  activeDefinitionSelection: DefinitionTextSelection | undefined,
  onDefinitionWordClick: (click: DefinitionWordClick) => void,
): ReactNode {
  const selection = isValidDefinitionSelection(definitionText, activeDefinitionSelection)
    ? activeDefinitionSelection
    : undefined;
  const nodes: ReactNode[] = [];
  const matcher = new RegExp(HYPHENATED_WORD_RE.source, HYPHENATED_WORD_RE.flags);
  let cursor = 0;
  let match = matcher.exec(definitionText);

  while (match) {
    const compoundStart = match.index;
    const compoundEnd = compoundStart + match[0].length;
    nodes.push(...renderClickableDefinitionRange(
      definitionText,
      cursor,
      compoundStart,
      selection,
      true,
      onDefinitionWordClick,
    ));
    const compoundIsActive = selection?.start === compoundStart && selection.end === compoundEnd;
    const componentInCompoundIsActive = selection !== undefined
      && selection.start >= compoundStart
      && selection.end <= compoundEnd
      && !compoundIsActive;
    nodes.push(
      <span
        key={`compound-${compoundStart}-${compoundEnd}`}
        className={cn(
          'rounded-[2px]',
          !componentInCompoundIsActive && 'hover:bg-primary/10',
          compoundIsActive && 'bg-primary/15',
        )}
      >
        {renderClickableDefinitionRange(
          definitionText,
          compoundStart,
          compoundEnd,
          compoundIsActive ? undefined : selection,
          false,
          onDefinitionWordClick,
        )}
      </span>,
    );
    cursor = compoundEnd;
    match = matcher.exec(definitionText);
  }

  nodes.push(...renderClickableDefinitionRange(
    definitionText,
    cursor,
    definitionText.length,
    selection,
    true,
    onDefinitionWordClick,
  ));
  return <>{nodes}</>;
}

function renderCompactDefinitions(
  definitions: string[],
  activeDefinitionSelection: DefinitionTextSelection | undefined,
  onDefinitionWordClick: (click: DefinitionWordClick) => void,
): ReactNode {
  if (definitions.length === 1) {
    return (
      <p className="text-foreground/80 leading-snug">
        {renderClickableDefinition(definitions[0], activeDefinitionSelection, onDefinitionWordClick)}
      </p>
    );
  }
  return (
    <ol className="text-foreground/80 leading-snug list-decimal pl-[1.25em] space-y-1">
      {definitions.map((definition) => (
        <li key={definition}>{renderClickableDefinition(definition, activeDefinitionSelection, onDefinitionWordClick)}</li>
      ))}
    </ol>
  );
}

function renderExpandedDefinitions(
  definitions: string[],
  activeDefinitionSelection: DefinitionTextSelection | undefined,
  onDefinitionWordClick: (click: DefinitionWordClick) => void,
): ReactNode {
  if (definitions.length === 1) {
    return (
      <p className="text-foreground/90 leading-relaxed">
        {renderClickableDefinition(definitions[0], activeDefinitionSelection, onDefinitionWordClick)}
      </p>
    );
  }
  return (
    <ol className="text-foreground/90 leading-relaxed list-decimal pl-[1.25em] space-y-1">
      {definitions.map((definition) => (
        <li key={definition}>{renderClickableDefinition(definition, activeDefinitionSelection, onDefinitionWordClick)}</li>
      ))}
    </ol>
  );
}

export function WordDefinitionCard({
  definition,
  activeDefinitionSelection,
  fontSize,
  onDefinitionWordClick,
  onMarkKnown,
  onMarkUnknown,
  compact = false,
  isMarkedKnown = false,
  isMarkedUnknown = false,
  pronunciationVariant = 'US',
  definitionStatus = 'ready',
}: WordDefinitionCardProps) {
  const cardFontSize = resolveDefinitionCardFontSize(fontSize);
  if (compact) {
    return (
      <div
        data-definition-card="true"
        className="inline-flex flex-col bg-popover border border-border rounded-md shadow-sm px-3 pt-2.5 pb-3 mx-2 my-1 max-w-[250px] max-h-[70vh] overflow-y-auto align-middle"
        style={{ fontSize: `${cardFontSize}px` }}
      >
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <span className="font-serif font-medium text-[1.1em]">{definition.word}</span>
          <div className="flex gap-1">
            <button
              type="button"
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
              type="button"
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
        {definitionStatus === 'loading' ? (
          <p className="text-muted-foreground leading-snug">Loading definition…</p>
        ) : definitionStatus === 'error' ? (
          <p className="text-destructive leading-snug">Definition could not be loaded.</p>
        ) : definition.senses.length === 0 ? (
          <p className="text-foreground/80 leading-snug">Definition unavailable in this build.</p>
        ) : (
          <div className="space-y-2.5">
            {definition.senses.map((sense) => {
              const ipaText = resolveLexiconPronunciations(sense, pronunciationVariant).preferred;
              return (
                <section key={sense.partOfSpeech}>
                  <div className="flex items-baseline gap-2 mb-0.5">
                    <span className="text-[0.68em] font-medium uppercase tracking-wide text-primary">
                      {formatPartOfSpeech(sense.partOfSpeech)}
                    </span>
                    {ipaText.length > 0 && (
                      <span className="text-[0.75em] text-muted-foreground italic">{ipaText}</span>
                    )}
                  </div>
                  {renderCompactDefinitions(sense.definitions, activeDefinitionSelection, onDefinitionWordClick)}
                </section>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-definition-card="true"
      className="bg-popover rounded-lg p-5 w-[300px]"
      style={{ fontSize: `${cardFontSize}px` }}
    >
      <div className="flex justify-between items-start mb-3">
        <h3 className="font-serif text-[1.33em] font-medium text-foreground">{definition.word}</h3>
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
      {definitionStatus === 'loading' ? (
        <p className="text-muted-foreground leading-relaxed">Loading definition…</p>
      ) : definitionStatus === 'error' ? (
        <p className="text-destructive leading-relaxed">Definition could not be loaded.</p>
      ) : definition.senses.length === 0 ? (
        <p className="text-foreground/90 leading-relaxed">Definition unavailable in this build.</p>
      ) : (
        <div className="space-y-3">
          {definition.senses.map((sense) => {
            const ipaText = resolveLexiconPronunciations(sense, pronunciationVariant).preferred;
            return (
              <section key={sense.partOfSpeech}>
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-[0.75em] font-medium uppercase tracking-wide text-primary">
                    {formatPartOfSpeech(sense.partOfSpeech)}
                  </span>
                  {ipaText.length > 0 && (
                    <span className="text-[0.875em] text-muted-foreground italic">{ipaText}</span>
                  )}
                </div>
                {renderExpandedDefinitions(sense.definitions, activeDefinitionSelection, onDefinitionWordClick)}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
