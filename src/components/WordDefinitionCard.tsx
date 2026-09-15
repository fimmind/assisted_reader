import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { HYPHENATED_WORD_RE, WORD_RE } from '@/core/constants';
import { resolveLexiconPronunciations } from '@/core/lexicon';
import type { LexiconEntry, PartOfSpeech } from '@/core/types';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip';

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

interface VocabularyStatusControlProps {
  isMarkedKnown: boolean;
  isMarkedUnknown: boolean;
  onMarkKnown: (() => void) | undefined;
  onMarkUnknown: (() => void) | undefined;
  tooltipSideOffset: number;
}

const vocabularyStatusTooltipClassName: string = 'border-0 bg-transparent px-1 py-0 text-[10px] font-normal text-muted-foreground shadow-none drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]';

function VocabularyStatusControl({
  isMarkedKnown,
  isMarkedUnknown,
  onMarkKnown,
  onMarkUnknown,
  tooltipSideOffset,
}: VocabularyStatusControlProps): ReactNode {
  return (
    <TooltipProvider delayDuration={400}>
      <div
        className="inline-flex -translate-y-0.5 shrink-0"
        role="group"
        aria-label="Vocabulary status"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onMarkUnknown}
              className={cn(
                'flex h-7 w-6 items-center justify-center rounded-sm text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                isMarkedUnknown && 'font-semibold text-foreground',
              )}
              aria-label="Mark as still learning"
              aria-pressed={isMarkedUnknown}
            >
              <span aria-hidden="true">?</span>
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            sideOffset={tooltipSideOffset}
            className={vocabularyStatusTooltipClassName}
          >
            Still learning
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onMarkKnown}
              className={cn(
                'flex h-7 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                isMarkedKnown && 'text-primary',
              )}
              aria-label="Mark as known"
              aria-pressed={isMarkedKnown}
            >
              <Check size={14} aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            sideOffset={tooltipSideOffset}
            className={vocabularyStatusTooltipClassName}
          >
            Known
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
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

function resolveTrailingPunctuationEnd(
  definitionText: string,
  wordEnd: number,
  rangeEnd: number,
): number {
  const match = definitionText
    .slice(wordEnd, rangeEnd)
    .match(/^[\p{P}\p{S}]+/u);
  return wordEnd + (match?.[0].length ?? 0);
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
    const punctuationEnd = resolveTrailingPunctuationEnd(
      definitionText,
      end,
      rangeEnd,
    );
    if (start > cursor) {
      nodes.push(definitionText.slice(cursor, start));
    }
    const wordIsActive = activeDefinitionSelection?.definitionText === definitionText
      && activeDefinitionSelection.start === start
      && activeDefinitionSelection.end === end;
    const wordButton = (
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
      </button>
    );
    nodes.push(
      punctuationEnd > end ? (
        <span key={`word-punctuation-${start}-${punctuationEnd}`} className="whitespace-nowrap">
          {wordButton}
          {definitionText.slice(end, punctuationEnd)}
        </span>
      ) : (
        wordButton
      ),
    );
    cursor = punctuationEnd;
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
    const punctuationEnd = resolveTrailingPunctuationEnd(
      definitionText,
      compoundEnd,
      definitionText.length,
    );
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
          punctuationEnd,
          compoundIsActive ? undefined : selection,
          false,
          onDefinitionWordClick,
        )}
      </span>,
    );
    cursor = punctuationEnd;
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
        className="inline-flex flex-col bg-popover border border-vocabulary-card-border rounded-md shadow-sm dark:shadow-md px-3 pt-2.5 pb-3 mx-2 my-1 max-w-[250px] max-h-[70vh] overflow-y-auto align-middle"
        style={{ fontSize: `${cardFontSize}px` }}
      >
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <span className="font-serif font-medium text-[1.1em]">{definition.word}</span>
          <VocabularyStatusControl
            isMarkedKnown={isMarkedKnown}
            isMarkedUnknown={isMarkedUnknown}
            onMarkKnown={onMarkKnown}
            onMarkUnknown={onMarkUnknown}
            tooltipSideOffset={10}
          />
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
      className="bg-popover border border-vocabulary-card-border rounded-lg shadow-sm dark:shadow-md p-5 w-[300px]"
      style={{ fontSize: `${cardFontSize}px` }}
    >
      <div className="flex justify-between items-start mb-3">
        <h3 className="font-serif text-[1.33em] font-medium text-foreground">{definition.word}</h3>
        <VocabularyStatusControl
          isMarkedKnown={isMarkedKnown}
          isMarkedUnknown={isMarkedUnknown}
          onMarkKnown={onMarkKnown}
          onMarkUnknown={onMarkUnknown}
          tooltipSideOffset={20}
        />
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
