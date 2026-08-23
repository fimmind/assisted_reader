import { STUDY_KNOWN_PROBABILITY_CEILING, WORD_TOKEN_RE } from './constants';
import { definitionTargetKey } from './definition-target';
import { resolveLexiconPronunciations } from './lexicon';
import type { LazyLexicon } from './lexicon';
import { normalizeToken } from './math';
import { splitSentenceSpans } from './nlp';
import { analyzeChapter, isAnalyzableLemma } from './reader-analysis';
import type { ChapterAnalysisInput } from './reader-analysis';
import type {
  LexiconEntry,
  LexiconSense,
  ParagraphAnalysis,
  ParagraphToken,
  PartOfSpeech,
  ReaderSettings,
  UserProfile,
  VocabularyModel,
} from './types';

export interface StudyTextScope {
  id: string;
  sourceDocumentId: string;
  chapterIndex: number;
  paragraphs: string[];
  paragraphOffset: number;
  unreadParagraphIndex: number | null;
}

export interface StudyTargetSpan {
  start: number;
  end: number;
}

export interface StudyOccurrence {
  surfaceForm: string;
  sentence: string;
  paragraphIndex: number;
  sentenceIndex: number;
  start: number;
  end: number;
  targetSpans: StudyTargetSpan[];
  sentenceWordCount: number;
  otherItemDifficulty: number;
  completeSentence: boolean;
  upcoming: boolean;
  contextualPartOfSpeech: PartOfSpeech | null;
}

export interface StudyCandidate {
  lexicalItemId: string;
  lemma: string;
  partOfSpeech: PartOfSpeech | null;
  pKnown: number;
  frequencyInScope: number;
  distinctParagraphCount: number;
  occurrences: StudyOccurrence[];
}

export interface SelectedStudyExample {
  sentence: string;
  paragraphIndex: number;
  sentenceIndex: number;
  targetSpans: StudyTargetSpan[];
  occurrenceKey: string;
}

export interface StudyDictionaryContent {
  definition: string;
  definitions?: string[];
  preferredTranscription: string;
  alternativeTranscriptions: string[];
}

export interface StudyCardItem extends StudyCandidate, StudyDictionaryContent {
  spelling: string;
  example: SelectedStudyExample;
}

export interface StudyCoverageEstimate {
  before: number;
  projectedAfter: number;
  eligibleTokenCount: number;
}

export interface StudyCoverageItem {
  lexicalItemId: string;
  lemma: string;
  pKnown: number;
  frequencyInScope: number;
}

export interface StudyAnalysisInput {
  scope: StudyTextScope;
  settings: ReaderSettings;
  model: VocabularyModel;
  profile: UserProfile;
  lemmaDict: Record<string, string>;
  nlp: ChapterAnalysisInput['nlp'];
}

export interface StudyScopeAnalysis {
  candidates: StudyCandidate[];
  coverageItems: StudyCoverageItem[];
}

interface CandidateAccumulator {
  lexicalItemId: string;
  lemma: string;
  partOfSpeech: PartOfSpeech | null;
  pKnown: number;
  frequencyInScope: number;
  paragraphIndices: Set<number>;
  occurrences: StudyOccurrence[];
}

interface SentenceTokenContext {
  token: ParagraphToken;
  sentenceStart: number;
}

function isCompleteSentence(sentence: string): boolean {
  return /[.!?]["')\]]?$/.test(sentence.trim());
}

function isEligibleTokenShape(token: ParagraphToken): boolean {
  return (
    token.lemma.length > 0 &&
    isAnalyzableLemma(token.lemma) &&
    WORD_TOKEN_RE.test(token.lemma) &&
    !token.proper &&
    token.partOfSpeech !== 'proper-noun'
  );
}

export function createStudyLexicalItemId(
  lemma: string,
  partOfSpeech: PartOfSpeech | null,
): string {
  return definitionTargetKey({ lemma: normalizeToken(lemma), partOfSpeech });
}

function tokenMatchesCandidate(
  token: ParagraphToken,
  lemma: string,
  partOfSpeech: PartOfSpeech | null,
): boolean {
  if (normalizeToken(token.lemma) !== lemma) {
    return false;
  }
  return partOfSpeech === null || token.partOfSpeech === partOfSpeech;
}

function buildTargetSpans(
  sentenceTokens: SentenceTokenContext[],
  lemma: string,
  partOfSpeech: PartOfSpeech | null,
): StudyTargetSpan[] {
  return sentenceTokens
    .filter(({ token }) => tokenMatchesCandidate(token, lemma, partOfSpeech))
    .map(({ token, sentenceStart }) => ({
      start: token.start - sentenceStart,
      end: token.end - sentenceStart,
    }));
}

function calculateOtherItemDifficulty(
  sentenceTokens: SentenceTokenContext[],
  targetLexicalItemId: string,
): number {
  return sentenceTokens.reduce((total, { token }) => {
    if (!isEligibleTokenShape(token)) {
      return total;
    }
    const tokenId = createStudyLexicalItemId(token.lemma, token.partOfSpeech);
    return tokenId === targetLexicalItemId ? total : total + (1 - token.pKnown);
  }, 0);
}

function buildOccurrence(
  token: ParagraphToken,
  sentenceTokens: SentenceTokenContext[],
  sentence: string,
  sentenceStart: number,
  paragraphIndex: number,
  sentenceIndex: number,
  unreadParagraphIndex: number | null,
): StudyOccurrence {
  const lemma = normalizeToken(token.lemma);
  const lexicalItemId = createStudyLexicalItemId(lemma, token.partOfSpeech);
  return {
    surfaceForm: token.raw,
    sentence,
    paragraphIndex,
    sentenceIndex,
    start: token.start - sentenceStart,
    end: token.end - sentenceStart,
    targetSpans: buildTargetSpans(sentenceTokens, lemma, token.partOfSpeech),
    sentenceWordCount: sentenceTokens.length,
    otherItemDifficulty: calculateOtherItemDifficulty(
      sentenceTokens,
      lexicalItemId,
    ),
    completeSentence: isCompleteSentence(sentence),
    upcoming:
      unreadParagraphIndex === null || paragraphIndex >= unreadParagraphIndex,
    contextualPartOfSpeech: token.partOfSpeech,
  };
}

function collectCandidateAccumulators(
  scope: StudyTextScope,
  analyses: ParagraphAnalysis[],
): Map<string, CandidateAccumulator> {
  const candidates = new Map<string, CandidateAccumulator>();

  for (
    let localParagraphIndex = 0;
    localParagraphIndex < analyses.length;
    localParagraphIndex += 1
  ) {
    const analysis = analyses[localParagraphIndex];
    const paragraphIndex = scope.paragraphOffset + localParagraphIndex;
    const sentenceSpans = splitSentenceSpans(analysis.paragraphText);

    for (
      let sentenceIndex = 0;
      sentenceIndex < sentenceSpans.length;
      sentenceIndex += 1
    ) {
      const sentenceSpan = sentenceSpans[sentenceIndex];
      const sentenceTokens = analysis.tokens
        .filter(
          (token) =>
            token.start >= sentenceSpan.start && token.end <= sentenceSpan.end,
        )
        .map((token) => ({ token, sentenceStart: sentenceSpan.start }));

      for (const { token } of sentenceTokens) {
        if (!isEligibleTokenShape(token)) {
          continue;
        }
        const lemma = normalizeToken(token.lemma);
        const lexicalItemId = createStudyLexicalItemId(
          lemma,
          token.partOfSpeech,
        );
        const existing = candidates.get(lexicalItemId) ?? {
          lexicalItemId,
          lemma,
          partOfSpeech: token.partOfSpeech,
          pKnown: token.pKnown,
          frequencyInScope: 0,
          paragraphIndices: new Set<number>(),
          occurrences: [],
        };
        existing.frequencyInScope += 1;
        existing.pKnown = Math.min(existing.pKnown, token.pKnown);
        existing.paragraphIndices.add(paragraphIndex);
        existing.occurrences.push(
          buildOccurrence(
            token,
            sentenceTokens,
            sentenceSpan.text,
            sentenceSpan.start,
            paragraphIndex,
            sentenceIndex,
            scope.unreadParagraphIndex,
          ),
        );
        candidates.set(lexicalItemId, existing);
      }
    }
  }
  return candidates;
}

export function extractStudyCandidates(
  scope: StudyTextScope,
  analyses: ParagraphAnalysis[],
  profile: UserProfile,
): StudyCandidate[] {
  const accumulators = collectCandidateAccumulators(scope, analyses);
  const output: StudyCandidate[] = [];

  for (const accumulator of accumulators.values()) {
    const explicitObservation = profile.observations[accumulator.lemma];
    if (explicitObservation === 1) {
      continue;
    }
    if (
      accumulator.pKnown > STUDY_KNOWN_PROBABILITY_CEILING &&
      explicitObservation !== 0
    ) {
      continue;
    }
    const completeOccurrences = accumulator.occurrences.filter(
      (occurrence) => occurrence.completeSentence,
    );
    if (completeOccurrences.length === 0) {
      continue;
    }
    output.push({
      lexicalItemId: accumulator.lexicalItemId,
      lemma: accumulator.lemma,
      partOfSpeech: accumulator.partOfSpeech,
      pKnown: accumulator.pKnown,
      frequencyInScope: accumulator.frequencyInScope,
      distinctParagraphCount: accumulator.paragraphIndices.size,
      occurrences: completeOccurrences,
    });
  }
  return output;
}

export function extractStudyCoverageItems(
  scope: StudyTextScope,
  analyses: ParagraphAnalysis[],
): StudyCoverageItem[] {
  return Array.from(collectCandidateAccumulators(scope, analyses).values()).map(
    (accumulator) => ({
      lexicalItemId: accumulator.lexicalItemId,
      lemma: accumulator.lemma,
      pKnown: accumulator.pKnown,
      frequencyInScope: accumulator.frequencyInScope,
    }),
  );
}

export function analyzeStudyScope(
  input: StudyAnalysisInput,
): StudyScopeAnalysis {
  const unreadLocalIndex =
    input.scope.unreadParagraphIndex === null
      ? 0
      : Math.max(
          0,
          input.scope.unreadParagraphIndex - input.scope.paragraphOffset,
        );
  const analysisScope: StudyTextScope = {
    ...input.scope,
    paragraphs: input.scope.paragraphs.slice(unreadLocalIndex),
    paragraphOffset: input.scope.paragraphOffset + unreadLocalIndex,
  };
  const analyses = analyzeChapter({
    chapter: { title: '', paragraphs: analysisScope.paragraphs },
    settings: input.settings,
    model: input.model,
    profile: input.profile,
    lemmaDict: input.lemmaDict,
    nlp: input.nlp,
    maxCardsPerParagraph: 1,
    includeCards: false,
  });
  return {
    candidates: extractStudyCandidates(analysisScope, analyses, input.profile),
    coverageItems: extractStudyCoverageItems(analysisScope, analyses),
  };
}

function earliestOccurrence(candidate: StudyCandidate): StudyOccurrence {
  const occurrence = candidate.occurrences[0];
  if (!occurrence) {
    throw new Error(
      `Study candidate has no occurrences: lexicalItemId=${candidate.lexicalItemId}`,
    );
  }
  return occurrence;
}

export function rankStudyCandidates<T extends StudyCandidate>(
  candidates: T[],
): T[] {
  return [...candidates].sort((left, right) => {
    const priorityDelta =
      right.frequencyInScope * (1 - right.pKnown) -
      left.frequencyInScope * (1 - left.pKnown);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    if (right.distinctParagraphCount !== left.distinctParagraphCount) {
      return right.distinctParagraphCount - left.distinctParagraphCount;
    }
    if (left.pKnown !== right.pKnown) {
      return left.pKnown - right.pKnown;
    }
    const leftOccurrence = earliestOccurrence(left);
    const rightOccurrence = earliestOccurrence(right);
    if (leftOccurrence.paragraphIndex !== rightOccurrence.paragraphIndex) {
      return leftOccurrence.paragraphIndex - rightOccurrence.paragraphIndex;
    }
    if (leftOccurrence.sentenceIndex !== rightOccurrence.sentenceIndex) {
      return leftOccurrence.sentenceIndex - rightOccurrence.sentenceIndex;
    }
    if (leftOccurrence.start !== rightOccurrence.start) {
      return leftOccurrence.start - rightOccurrence.start;
    }
    return left.lexicalItemId.localeCompare(right.lexicalItemId);
  });
}

export function selectStudyBatch<T extends StudyCandidate>(
  candidates: T[],
  excludedLexicalItemIds: ReadonlySet<string>,
  requestedCount: number,
): T[] {
  if (!Number.isInteger(requestedCount) || requestedCount < 1) {
    throw new RangeError(
      `Study batch count must be a positive integer: count=${requestedCount}`,
    );
  }
  return rankStudyCandidates(candidates)
    .filter((candidate) => !excludedLexicalItemIds.has(candidate.lexicalItemId))
    .slice(0, requestedCount);
}

function occurrenceKey(occurrence: StudyOccurrence): string {
  return `${occurrence.paragraphIndex}:${occurrence.sentenceIndex}`;
}

export function chooseStudyExample(
  candidate: StudyCandidate,
  excludedOccurrenceKey: string | null,
): SelectedStudyExample {
  const uniqueOccurrences = new Map<string, StudyOccurrence>();
  for (const occurrence of candidate.occurrences) {
    const key = occurrenceKey(occurrence);
    if (!uniqueOccurrences.has(key)) {
      uniqueOccurrences.set(key, occurrence);
    }
  }
  const allOccurrences = [...uniqueOccurrences.values()];
  const alternatives =
    excludedOccurrenceKey === null
      ? allOccurrences
      : allOccurrences.filter(
          (occurrence) => occurrenceKey(occurrence) !== excludedOccurrenceKey,
        );
  const pool = alternatives.length > 0 ? alternatives : allOccurrences;
  const sorted = [...pool].sort((left, right) => {
    if (left.upcoming !== right.upcoming) {
      return left.upcoming ? -1 : 1;
    }
    const leftModerate =
      left.sentenceWordCount >= 8 && left.sentenceWordCount <= 30;
    const rightModerate =
      right.sentenceWordCount >= 8 && right.sentenceWordCount <= 30;
    if (leftModerate !== rightModerate) {
      return leftModerate ? -1 : 1;
    }
    if (left.otherItemDifficulty !== right.otherItemDifficulty) {
      return left.otherItemDifficulty - right.otherItemDifficulty;
    }
    if (left.targetSpans.length !== right.targetSpans.length) {
      return left.targetSpans.length - right.targetSpans.length;
    }
    if (left.paragraphIndex !== right.paragraphIndex) {
      return left.paragraphIndex - right.paragraphIndex;
    }
    if (left.sentenceIndex !== right.sentenceIndex) {
      return left.sentenceIndex - right.sentenceIndex;
    }
    return left.start - right.start;
  });
  const selected = sorted[0];
  if (!selected) {
    throw new Error(
      `Cannot choose a Study example without occurrences: lexicalItemId=${candidate.lexicalItemId}`,
    );
  }
  return {
    sentence: selected.sentence,
    paragraphIndex: selected.paragraphIndex,
    sentenceIndex: selected.sentenceIndex,
    targetSpans: selected.targetSpans.map((span) => ({ ...span })),
    occurrenceKey: occurrenceKey(selected),
  };
}

function selectContextualSenses(
  entry: LexiconEntry,
  partOfSpeech: PartOfSpeech | null,
): LexiconSense[] {
  if (partOfSpeech === null) {
    return entry.senses.filter((sense) => sense.definitions.length > 0);
  }
  return entry.senses.filter(
    (sense) =>
      sense.partOfSpeech === partOfSpeech && sense.definitions.length > 0,
  );
}

function collectStudyDefinitions(senses: LexiconSense[]): string[] {
  const definitions = new Set<string>();
  for (const sense of senses) {
    for (const definition of sense.definitions) {
      const normalized = definition.trim();
      if (normalized.length > 0) {
        definitions.add(normalized);
      }
    }
  }
  return [...definitions];
}

export async function resolveStudyCandidate(
  candidate: StudyCandidate,
  lexicon: LazyLexicon,
  variant: ReaderSettings['englishVariant'],
  excludedOccurrenceKey: string | null,
): Promise<StudyCardItem | null> {
  const entry = await lexicon.lookup(candidate.lemma);
  if (!entry) {
    return null;
  }
  const senses = selectContextualSenses(entry, candidate.partOfSpeech);
  const definitions = collectStudyDefinitions(senses);
  const primarySense = senses[0];
  const definition = definitions[0] ?? '';
  if (!primarySense || definition.length === 0) {
    return null;
  }
  const pronunciations = resolveLexiconPronunciations(primarySense, variant);
  return {
    ...candidate,
    spelling: candidate.lemma,
    definition,
    definitions,
    preferredTranscription: pronunciations.preferred,
    alternativeTranscriptions: pronunciations.alternatives,
    example: chooseStudyExample(candidate, excludedOccurrenceKey),
  };
}

export async function resolveStudyCandidates(
  candidates: StudyCandidate[],
  lexicon: LazyLexicon,
  variant: ReaderSettings['englishVariant'],
): Promise<StudyCardItem[]> {
  const resolved = await Promise.all(
    candidates.map((candidate) =>
      resolveStudyCandidate(candidate, lexicon, variant, null),
    ),
  );
  return resolved.filter(
    (candidate): candidate is StudyCardItem => candidate !== null,
  );
}

export function calculateEstimatedCoverage(
  eligibleCandidates: StudyCoverageItem[],
  selectedLexicalItemIds: ReadonlySet<string>,
): StudyCoverageEstimate {
  const eligibleTokenCount = eligibleCandidates.reduce(
    (total, candidate) => total + candidate.frequencyInScope,
    0,
  );
  if (eligibleTokenCount === 0) {
    return { before: 1, projectedAfter: 1, eligibleTokenCount: 0 };
  }
  const coverageProbability = (candidate: StudyCoverageItem): number =>
    candidate.pKnown > STUDY_KNOWN_PROBABILITY_CEILING ? 1 : candidate.pKnown;
  const beforeKnownTokens = eligibleCandidates.reduce(
    (total, candidate) =>
      total + candidate.frequencyInScope * coverageProbability(candidate),
    0,
  );
  const projectedKnownTokens = eligibleCandidates.reduce((total, candidate) => {
    const probability = selectedLexicalItemIds.has(candidate.lexicalItemId)
      ? 1
      : coverageProbability(candidate);
    return total + candidate.frequencyInScope * probability;
  }, 0);
  return {
    before: beforeKnownTokens / eligibleTokenCount,
    projectedAfter: projectedKnownTokens / eligibleTokenCount,
    eligibleTokenCount,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function createStudyExampleHtml(example: SelectedStudyExample): string {
  const sortedSpans = [...example.targetSpans].sort(
    (left, right) => left.start - right.start,
  );
  let cursor = 0;
  let html = '';
  for (const span of sortedSpans) {
    if (
      span.start < cursor ||
      span.end <= span.start ||
      span.end > example.sentence.length
    ) {
      throw new RangeError(
        `Invalid Study example span: start=${span.start} end=${span.end} sentenceLength=${example.sentence.length}`,
      );
    }
    html += escapeHtml(example.sentence.slice(cursor, span.start));
    html += `<b>${escapeHtml(example.sentence.slice(span.start, span.end))}</b>`;
    cursor = span.end;
  }
  return html + escapeHtml(example.sentence.slice(cursor));
}

function normalizeExportField(
  value: string,
  preserveLineBreaks: boolean,
): string {
  const withoutTabs = value.replace(/\t/g, ' ');
  return withoutTabs.replace(/\r\n|\r|\n/g, preserveLineBreaks ? '<br>' : ' ');
}

export function createAnkiStudyText(items: StudyCardItem[]): string {
  const lines = ['#separator:tab', '#html:true'];
  for (const item of items) {
    const fields = [
      item.spelling,
      item.partOfSpeech ?? '',
      item.preferredTranscription,
      item.alternativeTranscriptions.join(', '),
      item.definition,
      createStudyExampleHtml(item.example),
    ];
    lines.push(
      fields
        .map((field, index) =>
          normalizeExportField(field, index === 3 || index === 5),
        )
        .join('\t'),
    );
  }
  return `${lines.join('\n')}\n`;
}

export function sanitizeStudyExportFilename(
  bookTitle: string,
  chapterIndex: number,
): string {
  const slug = normalizeToken(bookTitle)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  const safeBookTitle = slug.length > 0 ? slug : 'book';
  return `${safeBookTitle}-chapter-${chapterIndex + 1}-vocabulary.txt`;
}
