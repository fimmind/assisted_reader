export interface ReaderSettings {
  fontSize: number;
  lineSpacing: 'Compact' | 'Normal' | 'Relaxed';
  fontChoice: 'Serif' | 'Sans';
  pageWidth: 'Narrow' | 'Normal' | 'Wide';
  maxWordsPerParagraph: number;
  deduplicationRadius: number;
  knowledgeThreshold: number;
  englishVariant: 'US' | 'UK';
}

export interface BookChapter {
  title: string;
  paragraphs: string[];
}

export interface ImportedBook {
  id: string;
  title: string;
  author: string;
  sourceType: 'txt' | 'epub';
  createdAt: string;
  updatedAt: string;
  currentChapter: number;
  currentChapterProgress: number;
  chapters: BookChapter[];
}

export interface VocabularyModel {
  modelKey: string;
  modelName: string;
  words: string[];
  accuracy: number[];
  difficulties: number[];
  wordToIdx: Map<string, number>;
  candidatePool: string[];
  candidatePositions: Map<string, number>;
}

export type PartOfSpeech =
  | 'noun'
  | 'proper-noun'
  | 'verb'
  | 'adjective'
  | 'adverb'
  | 'pronoun'
  | 'determiner'
  | 'article'
  | 'preposition'
  | 'postposition'
  | 'conjunction'
  | 'interjection'
  | 'numeral'
  | 'particle'
  | 'classifier'
  | 'phrase'
  | 'abbreviation'
  | 'contraction'
  | 'prefix'
  | 'infix'
  | 'suffix'
  | 'symbol'
  | 'other';

export interface LexiconSense {
  partOfSpeech: PartOfSpeech;
  ipa: string;
  ipaUs?: string;
  ipaUk?: string;
  definitions: string[];
}

export interface LexiconEntry {
  word: string;
  senses: LexiconSense[];
}

export interface DefinitionTarget {
  lemma: string;
  partOfSpeech: PartOfSpeech | null;
}

export interface UserProfile {
  id: string;
  name: string;
  observations: Record<string, 0 | 1>;
  createdAt: string;
}

export interface ProfileState {
  activeProfileId: string;
  profiles: UserProfile[];
}

export interface TaggedTerm {
  raw: string;
  normalized: string;
  tags: Set<string>;
  sentenceInitial: boolean;
}

export interface TaggedSentence {
  text: string;
  terms: TaggedTerm[];
}

export interface DeinflectionResult {
  tokens: string[];
  properFlags: boolean[];
  partsOfSpeech: Array<PartOfSpeech | null>;
}

export interface ParagraphToken {
  raw: string;
  start: number;
  end: number;
  lemma: string;
  pKnown: number;
  unknown: boolean;
  proper: boolean;
  partOfSpeech: PartOfSpeech | null;
}

export interface ParagraphAnalysis {
  paragraphText: string;
  tokens: ParagraphToken[];
  cardTargets: DefinitionTarget[];
}

export interface BookStats {
  unknownTokenCount: number;
  unknownTokenPercent: number;
  progressPercent: number;
}

export interface QuizState {
  seed: number;
  queried: string[];
  totalWords: number;
  batchSize: number;
  currentBatch: number;
}
