import { WORD_RE } from './constants';
import { buildHighConfidenceProperNounLexicon, buildTaggedSentences, contextualDeinflectTaggedTerms } from './nlp';
import { normalizeToken } from './math';
import { estimateTheta, predictKnownProbability } from './model';
import type { BookChapter, BookStats, ParagraphAnalysis, ParagraphToken, ReaderSettings, TaggedSentence, UserProfile, VocabularyModel } from './types';

function resolveKnowledgeThreshold(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  if (value < 0.05) {
    return 0.05;
  }
  if (value > 0.95) {
    return 0.95;
  }
  return value;
}

function resolveDeduplicationRadius(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const integer = Math.trunc(value);
  if (integer < 0) {
    return 0;
  }
  if (integer > 20) {
    return 20;
  }
  return integer;
}

export interface ChapterAnalysisInput {
  chapter: BookChapter;
  settings: ReaderSettings;
  model: VocabularyModel;
  profile: UserProfile;
  lemmaDict: Record<string, string>;
  nlp: ((text: string) => {
    terms: () => {
      json: () => Array<{ text?: string; normal?: string; tags?: string[]; terms?: Array<{ text?: string; normal?: string; tags?: string[] }> }>;
    };
    verbs: () => { toInfinitive: () => { out: (format: 'text') => string } };
    nouns: () => { toSingular: () => { out: (format: 'text') => string } };
    adjectives: () => { conjugate: () => Array<Record<string, string>> };
  }) | null;
  maxCardsPerParagraph: number;
  includeCards?: boolean;
  thetaOverride?: number;
}

export interface BookLemmaHistogram {
  totalTokenCount: number;
  nonProperLemmaCounts: Record<string, number>;
}

function flattenTaggedSentences(paragraphs: string[], nlp: ChapterAnalysisInput['nlp']): TaggedSentence[] {
  const output: TaggedSentence[] = [];
  for (const paragraph of paragraphs) {
    const tagged = buildTaggedSentences(paragraph, nlp);
    output.push(...tagged);
  }
  return output;
}

function buildTaggedSentenceGroups(paragraphs: string[], nlp: ChapterAnalysisInput['nlp']): TaggedSentence[][] {
  return paragraphs.map((paragraph) => buildTaggedSentences(paragraph, nlp));
}

function isAnalyzableLemma(lemma: string): boolean {
  const letterCount = lemma.replace(/['’]/g, '').length;
  return letterCount > 2;
}

function buildDeinflectedTerms(
  taggedSentences: TaggedSentence[],
  properLexicon: Set<string>,
  model: VocabularyModel,
  lemmaDict: Record<string, string>,
  nlp: ChapterAnalysisInput['nlp'],
  lemmaCandidateCache: Map<string, string[]>,
): Array<{ lemma: string; proper: boolean; raw: string }> {
  const deinflectedTerms: Array<{ lemma: string; proper: boolean; raw: string }> = [];

  for (const sentence of taggedSentences) {
    const deinflected = contextualDeinflectTaggedTerms(
      sentence.terms,
      lemmaDict,
      model.wordToIdx,
      properLexicon,
      true,
      nlp,
      lemmaCandidateCache,
    );

    for (let index = 0; index < sentence.terms.length; index += 1) {
      deinflectedTerms.push({
        raw: sentence.terms[index].raw,
        lemma: deinflected.tokens[index],
        proper: deinflected.properFlags[index],
      });
    }
  }

  return deinflectedTerms;
}

function buildParagraphTokenList(
  paragraph: string,
  taggedSentences: TaggedSentence[],
  properLexicon: Set<string>,
  model: VocabularyModel,
  profile: UserProfile,
  theta: number,
  lemmaDict: Record<string, string>,
  threshold: number,
  nlp: ChapterAnalysisInput['nlp'],
  knownProbabilityCache: Map<string, number>,
  lemmaCandidateCache: Map<string, string[]>,
): ParagraphToken[] {
  const deinflectedTerms = buildDeinflectedTerms(
    taggedSentences,
    properLexicon,
    model,
    lemmaDict,
    nlp,
    lemmaCandidateCache,
  );

  const tokens: ParagraphToken[] = [];
  let sequentialIndex = 0;
  let match = WORD_RE.exec(paragraph);
  while (match) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;

    const aligned = deinflectedTerms[sequentialIndex];
    const lemma = aligned?.lemma && aligned.lemma.length > 0 ? aligned.lemma : normalizeToken(raw);
    const proper = aligned?.proper ?? false;
    sequentialIndex += 1;

    if (!isAnalyzableLemma(lemma)) {
      match = WORD_RE.exec(paragraph);
      continue;
    }

    const cachedKnownProbability = knownProbabilityCache.get(lemma);
    const pKnown = cachedKnownProbability === undefined
      ? predictKnownProbability(model, profile, theta, lemma)
      : cachedKnownProbability;
    if (cachedKnownProbability === undefined) {
      knownProbabilityCache.set(lemma, pKnown);
    }
    const unknown = !proper && lemma.length > 0 && pKnown < threshold;

    tokens.push({
      raw,
      start,
      end,
      lemma,
      pKnown,
      unknown,
      proper,
    });
    match = WORD_RE.exec(paragraph);
  }
  WORD_RE.lastIndex = 0;

  return tokens;
}

function countParagraphUnknownTokens(
  paragraph: string,
  taggedSentences: TaggedSentence[],
  properLexicon: Set<string>,
  model: VocabularyModel,
  profile: UserProfile,
  theta: number,
  lemmaDict: Record<string, string>,
  threshold: number,
  nlp: ChapterAnalysisInput['nlp'],
  knownProbabilityCache: Map<string, number>,
  lemmaCandidateCache: Map<string, string[]>,
): { unknownTokenCount: number; totalTokenCount: number } {
  const deinflectedTerms = buildDeinflectedTerms(
    taggedSentences,
    properLexicon,
    model,
    lemmaDict,
    nlp,
    lemmaCandidateCache,
  );

  let unknownTokenCount = 0;
  let totalTokenCount = 0;
  let sequentialIndex = 0;
  let match = WORD_RE.exec(paragraph);
  while (match) {
    const raw = match[0];
    const aligned = deinflectedTerms[sequentialIndex];
    const lemma = aligned?.lemma && aligned.lemma.length > 0 ? aligned.lemma : normalizeToken(raw);
    const proper = aligned?.proper ?? false;
    sequentialIndex += 1;

    if (!isAnalyzableLemma(lemma)) {
      match = WORD_RE.exec(paragraph);
      continue;
    }

    totalTokenCount += 1;
    const cachedKnownProbability = knownProbabilityCache.get(lemma);
    const pKnown = cachedKnownProbability === undefined
      ? predictKnownProbability(model, profile, theta, lemma)
      : cachedKnownProbability;
    if (cachedKnownProbability === undefined) {
      knownProbabilityCache.set(lemma, pKnown);
    }
    const unknown = !proper && lemma.length > 0 && pKnown < threshold;
    if (unknown) {
      unknownTokenCount += 1;
    }

    match = WORD_RE.exec(paragraph);
  }
  WORD_RE.lastIndex = 0;

  return { unknownTokenCount, totalTokenCount };
}

function collectParagraphLemmaHistogram(
  paragraph: string,
  taggedSentences: TaggedSentence[],
  properLexicon: Set<string>,
  model: VocabularyModel,
  lemmaDict: Record<string, string>,
  nlp: ChapterAnalysisInput['nlp'],
  lemmaCandidateCache: Map<string, string[]>,
): { totalTokenCount: number; nonProperLemmaCounts: Map<string, number> } {
  const deinflectedTerms = buildDeinflectedTerms(
    taggedSentences,
    properLexicon,
    model,
    lemmaDict,
    nlp,
    lemmaCandidateCache,
  );

  let totalTokenCount = 0;
  const nonProperLemmaCounts = new Map<string, number>();
  let sequentialIndex = 0;
  let match = WORD_RE.exec(paragraph);
  while (match) {
    const raw = match[0];
    const aligned = deinflectedTerms[sequentialIndex];
    const lemma = aligned?.lemma && aligned.lemma.length > 0 ? aligned.lemma : normalizeToken(raw);
    const proper = aligned?.proper ?? false;
    sequentialIndex += 1;

    if (!isAnalyzableLemma(lemma)) {
      match = WORD_RE.exec(paragraph);
      continue;
    }

    totalTokenCount += 1;
    if (!proper && lemma.length > 0) {
      nonProperLemmaCounts.set(lemma, (nonProperLemmaCounts.get(lemma) ?? 0) + 1);
    }

    match = WORD_RE.exec(paragraph);
  }
  WORD_RE.lastIndex = 0;

  return { totalTokenCount, nonProperLemmaCounts };
}

function scoreCardLemmas(tokens: ParagraphToken[], threshold: number): string[] {
  const frequencies = new Map<string, { count: number; pKnown: number; firstIndex: number }>();
  tokens.forEach((token, index) => {
    if (!token.unknown) {
      return;
    }

    const current = frequencies.get(token.lemma);
    if (!current) {
      frequencies.set(token.lemma, { count: 1, pKnown: token.pKnown, firstIndex: index });
      return;
    }

    current.count += 1;
    if (token.pKnown < current.pKnown) {
      current.pKnown = token.pKnown;
    }
  });

  const denominator = 1 - threshold;
  const scored = Array.from(frequencies.entries()).map(([lemma, value]) => {
    const uncertaintyScore = denominator <= 0 ? 1 : (1 - value.pKnown) / denominator;
    const importance = (0.7 * value.count) + (0.3 * uncertaintyScore);
    return {
      lemma,
      importance,
      firstIndex: value.firstIndex,
    };
  });

  scored.sort((left, right) => {
    if (right.importance !== left.importance) {
      return right.importance - left.importance;
    }
    return left.firstIndex - right.firstIndex;
  });

  return scored.map((entry) => entry.lemma);
}

export function analyzeChapter(input: ChapterAnalysisInput): ParagraphAnalysis[] {
  const includeCards = input.includeCards !== false;
  const theta = (
    typeof input.thetaOverride === 'number' && Number.isFinite(input.thetaOverride)
      ? input.thetaOverride
      : estimateTheta(input.model, input.profile)
  );
  const threshold = resolveKnowledgeThreshold(input.settings.knowledgeThreshold);
  const deduplicationRadius = resolveDeduplicationRadius(input.settings.deduplicationRadius);
  const knownProbabilityCache = new Map<string, number>();
  const lemmaCandidateCache = new Map<string, string[]>();
  const taggedByParagraph = buildTaggedSentenceGroups(input.chapter.paragraphs, input.nlp);
  const allTaggedSentences = taggedByParagraph.flat();
  const properLexicon = buildHighConfidenceProperNounLexicon(allTaggedSentences);

  const paragraphTokens = input.chapter.paragraphs.map((paragraph, paragraphIndex) => {
    const taggedSentences = taggedByParagraph[paragraphIndex] ?? [];
    const tokens = buildParagraphTokenList(
      paragraph,
      taggedSentences,
      properLexicon,
      input.model,
      input.profile,
      theta,
      input.lemmaDict,
      threshold,
      input.nlp,
      knownProbabilityCache,
      lemmaCandidateCache,
    );
    return tokens;
  });

  const selectedCardLemmasByParagraph: string[][] = [];
  if (includeCards) {
    const rankedCardLemmasByParagraph = paragraphTokens.map((tokens) => scoreCardLemmas(tokens, threshold));
    for (let paragraphIndex = 0; paragraphIndex < rankedCardLemmasByParagraph.length; paragraphIndex += 1) {
      const rankedLemmas = rankedCardLemmasByParagraph[paragraphIndex];
      const nearbyShownLemmas = new Set<string>();
      if (deduplicationRadius > 0) {
        const fromIndex = Math.max(0, paragraphIndex - deduplicationRadius);
        for (let index = fromIndex; index < paragraphIndex; index += 1) {
          const previousSelection = selectedCardLemmasByParagraph[index] ?? [];
          for (const lemma of previousSelection) {
            nearbyShownLemmas.add(lemma);
          }
        }
      }

      const selectedLemmas: string[] = [];
      for (const lemma of rankedLemmas) {
        if (selectedLemmas.length >= input.maxCardsPerParagraph) {
          break;
        }
        if (nearbyShownLemmas.has(lemma)) {
          continue;
        }
        selectedLemmas.push(lemma);
        nearbyShownLemmas.add(lemma);
      }
      selectedCardLemmasByParagraph.push(selectedLemmas);
    }
  } else {
    for (let paragraphIndex = 0; paragraphIndex < paragraphTokens.length; paragraphIndex += 1) {
      selectedCardLemmasByParagraph.push([]);
    }
  }

  return input.chapter.paragraphs.map((paragraph, paragraphIndex) => {
    const tokens = paragraphTokens[paragraphIndex] ?? [];
    const cardLemmas = selectedCardLemmasByParagraph[paragraphIndex] ?? [];
    return {
      paragraphText: paragraph,
      tokens,
      cardLemmas,
    };
  });
}

export function calculateBookStats(
  book: { chapters: BookChapter[]; currentChapter: number; currentChapterProgress?: number },
  settings: ReaderSettings,
  model: VocabularyModel,
  profile: UserProfile,
  lemmaDict: Record<string, string>,
  nlp: ChapterAnalysisInput['nlp'],
): BookStats {
  let unknownTokenCount = 0;
  let totalTokenCount = 0;
  const threshold = resolveKnowledgeThreshold(settings.knowledgeThreshold);
  const theta = estimateTheta(model, profile);
  const knownProbabilityCache = new Map<string, number>();
  const lemmaCandidateCache = new Map<string, string[]>();

  for (const chapter of book.chapters) {
    const taggedByParagraph = buildTaggedSentenceGroups(chapter.paragraphs, nlp);
    const allTagged = taggedByParagraph.flat();
    const properLexicon = buildHighConfidenceProperNounLexicon(allTagged);

    for (let paragraphIndex = 0; paragraphIndex < chapter.paragraphs.length; paragraphIndex += 1) {
      const paragraph = chapter.paragraphs[paragraphIndex];
      const taggedSentences = taggedByParagraph[paragraphIndex] ?? [];
      const counts = countParagraphUnknownTokens(
        paragraph,
        taggedSentences,
        properLexicon,
        model,
        profile,
        theta,
        lemmaDict,
        threshold,
        nlp,
        knownProbabilityCache,
        lemmaCandidateCache,
      );

      totalTokenCount += counts.totalTokenCount;
      unknownTokenCount += counts.unknownTokenCount;
    }
  }

  const unknownTokenPercent = totalTokenCount === 0 ? 0 : (unknownTokenCount / totalTokenCount) * 100;
  const chapterCount = book.chapters.length;
  const normalizedChapterProgress = (() => {
    if (typeof book.currentChapterProgress !== 'number' || !Number.isFinite(book.currentChapterProgress)) {
      return 0;
    }
    if (book.currentChapterProgress < 0) {
      return 0;
    }
    if (book.currentChapterProgress > 1) {
      return 1;
    }
    return book.currentChapterProgress;
  })();
  const completedChapters = Math.max(0, Math.min(chapterCount, book.currentChapter - 1));
  const progressPercent = chapterCount === 0 ? 0 : ((completedChapters + normalizedChapterProgress) / chapterCount) * 100;

  return {
    unknownTokenCount,
    unknownTokenPercent,
    progressPercent,
  };
}

export interface BookStatsAsyncHooks {
  onParagraphProcessed?: (processedParagraphs: number, totalParagraphs: number) => void;
  shouldContinue?: () => boolean;
  onYield?: () => Promise<void>;
  yieldEveryParagraphs?: number;
}

export function calculateBookStatsFromLemmaHistogram(
  histogram: BookLemmaHistogram,
  settings: ReaderSettings,
  model: VocabularyModel,
  profile: UserProfile,
): BookStats {
  const threshold = resolveKnowledgeThreshold(settings.knowledgeThreshold);
  const theta = estimateTheta(model, profile);
  const knownProbabilityCache = new Map<string, number>();
  let unknownTokenCount = 0;

  const entries = Object.entries(histogram.nonProperLemmaCounts);
  for (const [lemma, count] of entries) {
    const cachedKnownProbability = knownProbabilityCache.get(lemma);
    const pKnown = cachedKnownProbability === undefined
      ? predictKnownProbability(model, profile, theta, lemma)
      : cachedKnownProbability;
    if (cachedKnownProbability === undefined) {
      knownProbabilityCache.set(lemma, pKnown);
    }
    if (pKnown < threshold) {
      unknownTokenCount += count;
    }
  }

  const totalTokenCount = histogram.totalTokenCount;
  const unknownTokenPercent = totalTokenCount === 0 ? 0 : (unknownTokenCount / totalTokenCount) * 100;
  return {
    unknownTokenCount,
    unknownTokenPercent,
    progressPercent: 0,
  };
}

export async function buildBookLemmaHistogramAsync(
  book: { chapters: BookChapter[]; currentChapter: number; currentChapterProgress?: number },
  model: VocabularyModel,
  lemmaDict: Record<string, string>,
  nlp: ChapterAnalysisInput['nlp'],
  hooks?: BookStatsAsyncHooks,
): Promise<BookLemmaHistogram | null> {
  const totalParagraphs = book.chapters.reduce((accumulator, chapter) => accumulator + chapter.paragraphs.length, 0);
  const yieldEveryParagraphs = (() => {
    const raw = hooks?.yieldEveryParagraphs;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return 1;
    }
    return Math.max(1, Math.trunc(raw));
  })();
  let totalTokenCount = 0;
  const aggregateLemmaCounts = new Map<string, number>();
  let processedParagraphs = 0;
  const lemmaCandidateCache = new Map<string, string[]>();

  for (const chapter of book.chapters) {
    const taggedByParagraph = buildTaggedSentenceGroups(chapter.paragraphs, nlp);
    const allTagged = taggedByParagraph.flat();
    const properLexicon = buildHighConfidenceProperNounLexicon(allTagged);

    for (let paragraphIndex = 0; paragraphIndex < chapter.paragraphs.length; paragraphIndex += 1) {
      if (hooks?.shouldContinue && !hooks.shouldContinue()) {
        return null;
      }

      const paragraph = chapter.paragraphs[paragraphIndex];
      const taggedSentences = taggedByParagraph[paragraphIndex] ?? [];
      const histogram = collectParagraphLemmaHistogram(
        paragraph,
        taggedSentences,
        properLexicon,
        model,
        lemmaDict,
        nlp,
        lemmaCandidateCache,
      );
      totalTokenCount += histogram.totalTokenCount;
      for (const [lemma, count] of histogram.nonProperLemmaCounts.entries()) {
        aggregateLemmaCounts.set(lemma, (aggregateLemmaCounts.get(lemma) ?? 0) + count);
      }

      processedParagraphs += 1;
      if (hooks?.onParagraphProcessed) {
        hooks.onParagraphProcessed(processedParagraphs, totalParagraphs);
      }
      if (hooks?.onYield && processedParagraphs % yieldEveryParagraphs === 0) {
        await hooks.onYield();
      }
    }
  }

  return {
    totalTokenCount,
    nonProperLemmaCounts: Object.fromEntries(aggregateLemmaCounts.entries()),
  };
}

export async function calculateBookStatsAsync(
  book: { chapters: BookChapter[]; currentChapter: number; currentChapterProgress?: number },
  settings: ReaderSettings,
  model: VocabularyModel,
  profile: UserProfile,
  lemmaDict: Record<string, string>,
  nlp: ChapterAnalysisInput['nlp'],
  hooks?: BookStatsAsyncHooks,
): Promise<BookStats | null> {
  const totalParagraphs = book.chapters.reduce((accumulator, chapter) => accumulator + chapter.paragraphs.length, 0);
  const threshold = resolveKnowledgeThreshold(settings.knowledgeThreshold);
  const theta = estimateTheta(model, profile);
  const yieldEveryParagraphs = (() => {
    const raw = hooks?.yieldEveryParagraphs;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return 1;
    }
    return Math.max(1, Math.trunc(raw));
  })();
  let unknownTokenCount = 0;
  let totalTokenCount = 0;
  let processedParagraphs = 0;
  const knownProbabilityCache = new Map<string, number>();
  const lemmaCandidateCache = new Map<string, string[]>();

  for (const chapter of book.chapters) {
    const taggedByParagraph = buildTaggedSentenceGroups(chapter.paragraphs, nlp);
    const allTagged = taggedByParagraph.flat();
    const properLexicon = buildHighConfidenceProperNounLexicon(allTagged);

    for (let paragraphIndex = 0; paragraphIndex < chapter.paragraphs.length; paragraphIndex += 1) {
      if (hooks?.shouldContinue && !hooks.shouldContinue()) {
        return null;
      }

      const paragraph = chapter.paragraphs[paragraphIndex];
      const taggedSentences = taggedByParagraph[paragraphIndex] ?? [];
      const counts = countParagraphUnknownTokens(
        paragraph,
        taggedSentences,
        properLexicon,
        model,
        profile,
        theta,
        lemmaDict,
        threshold,
        nlp,
        knownProbabilityCache,
        lemmaCandidateCache,
      );

      totalTokenCount += counts.totalTokenCount;
      unknownTokenCount += counts.unknownTokenCount;

      processedParagraphs += 1;
      if (hooks?.onParagraphProcessed) {
        hooks.onParagraphProcessed(processedParagraphs, totalParagraphs);
      }
      if (hooks?.onYield && processedParagraphs % yieldEveryParagraphs === 0) {
        await hooks.onYield();
      }
    }
  }

  const unknownTokenPercent = totalTokenCount === 0 ? 0 : (unknownTokenCount / totalTokenCount) * 100;
  const chapterCount = book.chapters.length;
  const normalizedChapterProgress = (() => {
    if (typeof book.currentChapterProgress !== 'number' || !Number.isFinite(book.currentChapterProgress)) {
      return 0;
    }
    if (book.currentChapterProgress < 0) {
      return 0;
    }
    if (book.currentChapterProgress > 1) {
      return 1;
    }
    return book.currentChapterProgress;
  })();
  const completedChapters = Math.max(0, Math.min(chapterCount, book.currentChapter - 1));
  const progressPercent = chapterCount === 0 ? 0 : ((completedChapters + normalizedChapterProgress) / chapterCount) * 100;

  return {
    unknownTokenCount,
    unknownTokenPercent,
    progressPercent,
  };
}
