import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { analyzeChapter } from '@/core/reader-analysis';
import { buildDefinitionLookupCandidates, createDefinitionTarget, lookupFirstAvailableDefinition } from '@/core/definition-target';
import { createFallbackLexiconEntry, resolveLexiconEntry } from '@/core/lexicon';
import type { LazyLexicon } from '@/core/lexicon';
import { getActiveProfile, loadProfileState } from '@/core/profile-store';
import { marginForReductionLevel } from '@/core/wsd-filter';
import type { ChapterAnalysisInput } from '@/core/reader-analysis';
import type { DefinitionTarget, LexiconEntry, ReaderSettings, VocabularyModel } from '@/core/types';
import { ContextualDefinitionCard } from './ContextualDefinitionCard';
import { renderClickableDefinition } from './WordDefinitionCard';
import type { DefinitionTextSelection, DefinitionWordClick } from './WordDefinitionCard';

interface StudyDefinitionTextProps {
  definitions: string[];
  settings: ReaderSettings;
  model: VocabularyModel;
  lemmaDict: Record<string, string>;
  lexicon: LazyLexicon;
  nlp: ChapterAnalysisInput['nlp'];
  onMarkWord: (lemma: string, known: boolean) => void;
}

interface LookupPopup {
  id: number;
  anchor: DOMRect;
  context: string;
  selection: DefinitionTextSelection;
  target: DefinitionTarget;
  entry: LexiconEntry | null;
  status: 'loading' | 'ready' | 'error';
  top: number;
  left: number;
}

function popupPosition(anchor: DOMRect, width: number, height: number): { top: number; left: number } {
  const padding = 8;
  const boundedWidth = Math.min(width, window.innerWidth - padding * 2);
  const boundedHeight = Math.min(height, window.innerHeight - padding * 2);
  const right = anchor.right + padding;
  const left = right + boundedWidth <= window.innerWidth - padding
    ? right
    : anchor.left - boundedWidth - padding;
  return {
    top: Math.max(padding, Math.min(anchor.top, window.innerHeight - boundedHeight - padding)),
    left: Math.max(padding, Math.min(left, window.innerWidth - boundedWidth - padding)),
  };
}

export function StudyDefinitionText({
  definitions,
  settings,
  model,
  lemmaDict,
  lexicon,
  nlp,
  onMarkWord,
}: StudyDefinitionTextProps) {
  const [popups, setPopups] = useState<LookupPopup[]>([]);
  const nextPopupId = useRef(0);
  const popupElements = useRef<Array<HTMLDivElement | null>>([]);

  const openWord = (click: DefinitionWordClick, parentIndex: number | null): void => {
    const profile = getActiveProfile(loadProfileState());
    const analysis = analyzeChapter({
      chapter: { title: '', paragraphs: [click.definitionText] },
      settings,
      model,
      profile,
      lemmaDict,
      nlp,
      maxCardsPerParagraph: 1,
      includeCards: false,
    })[0];
    const token = analysis?.tokens.find((candidate) => candidate.start === click.start && candidate.end === click.end);
    const target = token?.lemma
      ? createDefinitionTarget(token.lemma, token.partOfSpeech)
      : createDefinitionTarget(click.definitionText.slice(click.start, click.end), null);
    const candidates = buildDefinitionLookupCandidates(click.definitionText, click.start, click.end, target);
    const initial = candidates[0];
    if (!initial) {
      return;
    }
    const anchor = click.element.getBoundingClientRect();
    const position = popupPosition(anchor, 270, 250);
    const id = nextPopupId.current++;
    const popup: LookupPopup = {
      id,
      anchor,
      context: click.definitionText,
      selection: { definitionText: click.definitionText, start: initial.selectionStart, end: initial.selectionEnd },
      target: initial.target,
      entry: null,
      status: 'loading',
      ...position,
    };
    setPopups((current) => [...(parentIndex === null ? [] : current.slice(0, parentIndex + 1)), popup]);
    void lookupFirstAvailableDefinition(lexicon, candidates)
      .then(({ candidate, entry }) => {
        setPopups((current) => current.map((item) => item.id === id ? {
          ...item,
          target: candidate.target,
          selection: { definitionText: click.definitionText, start: candidate.selectionStart, end: candidate.selectionEnd },
          entry,
          status: 'ready',
        } : item));
      })
      .catch((error: unknown) => {
        console.error('study-definition-lookup-failed', { word: initial.lookupWord, error });
        setPopups((current) => current.map((item) => item.id === id ? { ...item, status: 'error' } : item));
      });
  };

  useLayoutEffect(() => {
    if (popups.length === 0) {
      return;
    }
    const positions = popups.map((popup, index) => {
      const element = popupElements.current[index];
      return element ? popupPosition(popup.anchor, element.offsetWidth, element.offsetHeight) : { top: popup.top, left: popup.left };
    });
    if (positions.some((position, index) => position.top !== popups[index].top || position.left !== popups[index].left)) {
      setPopups((current) => current.map((popup, index) => ({ ...popup, ...positions[index] })));
    }
  }, [popups]);

  useEffect(() => {
    if (popups.length === 0) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const popupElement = target?.closest<HTMLElement>('[data-study-popup-index]');
      if (popupElement) {
        const index = Number(popupElement.dataset.studyPopupIndex);
        setPopups((current) => current.slice(0, index + 1));
      } else if (!target?.closest('[data-word-popup-trigger="true"]')) {
        setPopups([]);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPopups((current) => current.slice(0, -1));
      }
    };
    const onScroll = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest('[data-study-popup-index]')) {
        setPopups([]);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [popups.length]);

  const selectedRoot = popups[0]?.selection;
  return (
    <>
      {definitions.length === 1 ? (
        <p className="leading-relaxed">{renderClickableDefinition(definitions[0], selectedRoot, (click) => openWord(click, null))}</p>
      ) : (
        <ol className="list-inside list-decimal space-y-2 leading-relaxed">
          {definitions.map((definition) => (
            <li key={definition}>{renderClickableDefinition(definition, selectedRoot, (click) => openWord(click, null))}</li>
          ))}
        </ol>
      )}
      {popups.map((popup, index) => {
        const entry = popup.entry ?? createFallbackLexiconEntry(popup.target.lemma);
        const definition = resolveLexiconEntry(entry, popup.target);
        const observation = getActiveProfile(loadProfileState()).observations[popup.target.lemma];
        return (
          <div
            key={popup.id}
            ref={(element) => { popupElements.current[index] = element; }}
            data-study-popup-index={index}
            className="fixed z-[60]"
            style={{ top: popup.top, left: popup.left }}
          >
            {popup.status === 'loading' ? (
              <div className="rounded-md border bg-popover px-3 py-2 text-sm shadow-sm" role="status">Loading definition…</div>
            ) : (
              <ContextualDefinitionCard
                definition={definition}
                definitionStatus={popup.status}
                context={{ text: popup.context, start: popup.selection.start, end: popup.selection.end }}
                contextParagraphs={[popup.context]}
                contextParagraphIndex={0}
                wsdMode={settings.wsdMode}
                wsdPriority="popup"
                wsdMargin={settings.wsdMode === 'none' ? 0 : marginForReductionLevel(settings.wsdReductionLevel, settings.wsdMode)}
                wsdContextUnit={settings.wsdContextUnit}
                wsdContextSize={settings.wsdContextSize}
                pendingIndicator={<div className="rounded-md border bg-popover px-3 py-2 text-sm shadow-sm" role="status">Disambiguating definition…</div>}
                onWsdSettled={() => setPopups((current) => current.slice())}
                activeDefinitionSelection={popups[index + 1]?.selection}
                fontSize={settings.fontSize}
                onDefinitionWordClick={(click) => openWord(click, index)}
                onMarkKnown={() => { onMarkWord(popup.target.lemma, true); setPopups((current) => current.slice(0, index)); }}
                onMarkUnknown={() => { onMarkWord(popup.target.lemma, false); setPopups((current) => current.slice(0, index)); }}
                isMarkedKnown={observation === 1}
                isMarkedUnknown={observation === 0}
                pronunciationVariant={settings.englishVariant}
                compact
              />
            )}
          </div>
        );
      })}
    </>
  );
}
