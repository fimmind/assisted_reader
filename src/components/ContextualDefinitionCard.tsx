import { useEffect, useState } from 'react';
import type { ComponentProps } from 'react';
import { filterWordNetEntry, paragraphWindowForWsd, sentenceWindowForWsd, wordNetGlosses } from '@/core/wsd-filter';
import type { WsdContext } from '@/core/wsd-filter';
import { scoreWordSenses } from '@/core/wsd-runtime';
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
  onWsdSettled?: () => void;
}

interface ScoredDefinition {
  key: string;
  scores: number[];
}

export function ContextualDefinitionCard({
  context,
  contextParagraphs,
  contextParagraphIndex,
  wsdEnabled,
  wsdMargin,
  wsdContextUnit,
  wsdContextSize,
  onWsdSettled,
  definition,
  definitionStatus,
  ...cardProps
}: ContextualDefinitionCardProps) {
  const glosses = wordNetGlosses(definition);
  const needsScoring = wsdEnabled && definitionStatus === 'ready' && glosses.length > 1;
  const scoringContext = needsScoring && context
    ? wsdContextUnit === 'sentence'
      ? sentenceWindowForWsd(contextParagraphs, contextParagraphIndex, context, wsdContextSize)
      : paragraphWindowForWsd(contextParagraphs, contextParagraphIndex, context, wsdContextSize)
    : null;
  const requestKey = needsScoring ? JSON.stringify([scoringContext, glosses]) : '';
  const [scored, setScored] = useState<ScoredDefinition | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);

  useEffect(() => {
    if (!needsScoring) {
      return;
    }
    if (!scoringContext) {
      setError({ key: requestKey, message: `Missing WSD context for ${definition.word}` });
      return;
    }
    let active = true;
    void scoreWordSenses(scoringContext, glosses)
      .then((scores) => {
        if (active) {
          setScored({ key: requestKey, scores });
          setError(null);
          onWsdSettled?.();
        }
      })
      .catch((failure: unknown) => {
        if (active) {
          const message = failure instanceof Error ? failure.message : String(failure);
          console.error('wsd-definition-filter-failed', { word: definition.word, error: failure });
          setError({ key: requestKey, message });
          onWsdSettled?.();
        }
      });
    return () => { active = false; };
  }, [requestKey]);

  const currentError = error?.key === requestKey ? error : null;
  const readyScores = scored?.key === requestKey ? scored.scores : null;
  const visibleDefinition = readyScores
    ? filterWordNetEntry(definition, readyScores, wsdMargin)
    : definition;
  const visibleStatus = currentError
    ? 'error'
    : needsScoring && !readyScores ? 'loading' : definitionStatus;

  return (
    <WordDefinitionCard
      {...cardProps}
      definition={visibleDefinition}
      definitionStatus={visibleStatus}
    />
  );
}
