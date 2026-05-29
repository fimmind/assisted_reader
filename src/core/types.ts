export interface ReaderSettings {
  fontSize: number;
  lineSpacing: 'Compact' | 'Normal' | 'Relaxed';
  fontChoice: 'Serif' | 'Sans';
  pageWidth: 'Narrow' | 'Normal' | 'Wide';
  maxWordsPerParagraph: number;
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

export interface VocabularyModelPayload {
  model_key: string;
  model_name: string;
  words: string[];
  accuracy: number[];
  query_pool: string[];
  adaptive_candidate_pool?: string[];
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

export interface LexiconEntry {
  word: string;
  ipa: string;
  ipaUs?: string;
  ipaUk?: string;
  pos: string;
  definition: string;
  definitions?: string[];
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
}

export interface ParagraphToken {
  raw: string;
  start: number;
  end: number;
  lemma: string;
  pKnown: number;
  unknown: boolean;
  proper: boolean;
}

export interface ParagraphAnalysis {
  paragraphText: string;
  tokens: ParagraphToken[];
  cardLemmas: string[];
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
