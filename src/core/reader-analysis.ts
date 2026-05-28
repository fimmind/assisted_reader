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
): ParagraphToken[] {
  const deinflectedTerms: Array<{ lemma: string; proper: boolean; raw: string }> = [];

  for (const sentence of taggedSentences) {
    const deinflected = contextualDeinflectTaggedTerms(
      sentence.terms,
      lemmaDict,
      model.wordToIdx,
      properLexicon,
      true,
      nlp,
    );

    for (let index = 0; index < sentence.terms.length; index += 1) {
      deinflectedTerms.push({
        raw: sentence.terms[index].raw,
        lemma: deinflected.tokens[index],
        proper: deinflected.properFlags[index],
      });
    }
  }

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

    const pKnown = predictKnownProbability(model, profile, theta, lemma);
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

    sequentialIndex += 1;
    match = WORD_RE.exec(paragraph);
  }
  WORD_RE.lastIndex = 0;

  return tokens;
}

function selectCardLemmas(tokens: ParagraphToken[], maxCardsPerParagraph: number, threshold: number): string[] {
  if (maxCardsPerParagraph <= 0) {
    return [];
  }

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

  return scored.slice(0, maxCardsPerParagraph).map((entry) => entry.lemma);
}

export function analyzeChapter(input: ChapterAnalysisInput): ParagraphAnalysis[] {
  const theta = estimateTheta(input.model, input.profile);
  const threshold = resolveKnowledgeThreshold(input.settings.knowledgeThreshold);
  const taggedByParagraph = buildTaggedSentenceGroups(input.chapter.paragraphs, input.nlp);
  const allTaggedSentences = taggedByParagraph.flat();
  const properLexicon = buildHighConfidenceProperNounLexicon(allTaggedSentences);

  return input.chapter.paragraphs.map((paragraph, paragraphIndex) => {
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
    );

    const cardLemmas = selectCardLemmas(tokens, input.maxCardsPerParagraph, threshold);

    return {
      paragraphText: paragraph,
      tokens,
      cardLemmas,
    };
  });
}

export function calculateBookStats(
  book: { chapters: BookChapter[]; currentChapter: number },
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

  for (const chapter of book.chapters) {
    const taggedByParagraph = buildTaggedSentenceGroups(chapter.paragraphs, nlp);
    const allTagged = taggedByParagraph.flat();
    const properLexicon = buildHighConfidenceProperNounLexicon(allTagged);

    for (let paragraphIndex = 0; paragraphIndex < chapter.paragraphs.length; paragraphIndex += 1) {
      const paragraph = chapter.paragraphs[paragraphIndex];
      const taggedSentences = taggedByParagraph[paragraphIndex] ?? [];
      const tokens = buildParagraphTokenList(
        paragraph,
        taggedSentences,
        properLexicon,
        model,
        profile,
        theta,
        lemmaDict,
        threshold,
        nlp,
      );

      for (const token of tokens) {
        totalTokenCount += 1;
        if (token.unknown) {
          unknownTokenCount += 1;
        }
      }
    }
  }

  const unknownTokenPercent = totalTokenCount === 0 ? 0 : (unknownTokenCount / totalTokenCount) * 100;
  const chapterCount = book.chapters.length;
  const progressPercent = chapterCount === 0 ? 0 : (book.currentChapter / chapterCount) * 100;

  return {
    unknownTokenCount,
    unknownTokenPercent,
    progressPercent,
  };
}
