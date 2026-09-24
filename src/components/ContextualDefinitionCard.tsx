import { useEffect, useState } from 'react';
import type { ComponentProps } from 'react';
import { filterWordNetEntry, paragraphWindowForWsd, sentenceWindowForWsd, wordNetGlosses } from '@/core/wsd-filter';
import type { WsdContext } from '@/core/wsd-filter';
import { getWsdModelStatus, scoreWordSenses, subscribeWsdModelStatus } from '@/core/wsd-runtime';
import type { WsdRequestPriority } from '@/core/wsd-runtime';
import type { ReaderSettings } from '@/core/types';
import { WordDefinitionCard } from './WordDefinitionCard';

interface ContextualDefinitionCardProps extends ComponentProps<typeof WordDefinitionCard> {
  context: WsdContext | null;
  contextParagraphs: readonly string[];
  contextParagraphIndex: number;
  wsdEnabled: boolean;
  wsdMargin: number;
  wsdContextUnit: ReaderSettings['wsdContextUnit'];
  wsdContextSize: number;
  wsdPriority: WsdRequestPriority;
  onWsdSettled?: () => void;
}

interface ScoredDefinition {
  key: string;
  scores: number[];
}

function contextForScoring(
  paragraphs: readonly string[],
  paragraphIndex: number,
  context: WsdContext,
  unit: ReaderSettings['wsdContextUnit'],
  size: number,
): WsdContext {
  return unit === 'sentence'
    ? sentenceWindowForWsd(paragraphs, paragraphIndex, context, size)
    : paragraphWindowForWsd(paragraphs, paragraphIndex, context, size);
}

export function ContextualDefinitionCard({
  context,
  contextParagraphs,
  contextParagraphIndex,
  wsdEnabled,
  wsdMargin,
  wsdContextUnit,
  wsdContextSize,
  wsdPriority,
  onWsdSettled,
  definition,
  definitionStatus,
  ...cardProps
}: ContextualDefinitionCardProps) {
  const [modelPhase, setModelPhase] = useState(() => getWsdModelStatus().phase);
  const [cardElement, setCardElement] = useState<HTMLDivElement | null>(null);
  const [nearViewport, setNearViewport] = useState(wsdPriority === 'popup');
  const [scored, setScored] = useState<ScoredDefinition | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);

  useEffect(() => subscribeWsdModelStatus((status) => {
    setModelPhase((previous) => previous === status.phase ? previous : status.phase);
  }), []);
  useEffect(() => {
    if (wsdPriority === 'popup') {
      setNearViewport(true);
      return;
    }
    if (!cardElement) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => setNearViewport(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: '300px' },
    );
    observer.observe(cardElement);
    return () => observer.disconnect();
  }, [cardElement, wsdPriority]);

  const glosses = wordNetGlosses(definition);
  const hasWordNetChoices = wsdEnabled && definitionStatus === 'ready' && glosses.length > 1;
  const shouldScore = hasWordNetChoices && modelPhase === 'ready' && nearViewport;
  let scoringContext: WsdContext | null = null;
  let contextError: string | null = null;
  if (shouldScore) {
    if (!context) {
      contextError = `Missing WSD context for ${definition.word}`;
    } else {
      try {
        scoringContext = contextForScoring(contextParagraphs, contextParagraphIndex, context, wsdContextUnit, wsdContextSize);
      } catch (failure) {
        if (!(failure instanceof RangeError)) {
          throw failure;
        }
        contextError = failure.message;
      }
    }
  }
  const requestKey = scoringContext ? JSON.stringify([scoringContext, glosses]) : '';

  useEffect(() => {
    if (!shouldScore || !scoringContext) {
      return;
    }
    const controller = new AbortController();
    setError(null);
    void scoreWordSenses(scoringContext, glosses, wsdPriority, controller.signal)
      .then((scores) => {
        if (!controller.signal.aborted) {
          setScored({ key: requestKey, scores });
          onWsdSettled?.();
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          const message = failure instanceof Error ? failure.message : String(failure);
          console.error('wsd-definition-filter-failed', { word: definition.word, error: failure });
          setError({ key: requestKey, message });
          onWsdSettled?.();
        }
      });
    return () => controller.abort();
  }, [requestKey, modelPhase, shouldScore, wsdPriority]);

  const currentError = error?.key === requestKey ? error : null;
  const readyScores = shouldScore && scored?.key === requestKey ? scored.scores : null;
  const visibleDefinition = readyScores
    ? filterWordNetEntry(definition, readyScores, wsdMargin)
    : definition;
  const visibleStatus = hasWordNetChoices && modelPhase === 'ready' && !readyScores && !currentError && !contextError
    ? 'loading' : definitionStatus;
  const statusMessage = hasWordNetChoices && modelPhase === 'error'
    ? 'WSD unavailable. Showing all definitions; retry in Settings.'
    : currentError || contextError
      ? 'WSD could not filter this word. Showing all definitions.'
      : undefined;

  return (
    <WordDefinitionCard
      {...cardProps}
      cardRef={setCardElement}
      definition={visibleDefinition}
      definitionStatus={visibleStatus}
      statusMessage={statusMessage}
    />
  );
}
