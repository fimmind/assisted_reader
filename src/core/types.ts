export type WsdMode = 'none' | 'sayedshaun' | 'glite-lens' | 'ettin';

export interface ReaderSettings {
  fontSize: number;
  lineSpacing: 'Compact' | 'Normal' | 'Relaxed';
  fontChoice: 'Serif' | 'Sans';
  pageWidth: 'Narrow' | 'Normal' | 'Wide';
  maxWordsPerParagraph: number;
  deduplicationRadius: number;
  knowledgeThreshold: number;
  englishVariant: 'US' | 'UK';
  wsdMode: WsdMode;
  wsdReductionLevel: number;
  wsdContextUnit: 'sentence' | 'paragraph';
  wsdContextSize: number;
}

export type ReaderInlineMark = 'strong' | 'emphasis' | 'underline' | 'strike' | 'subscript' | 'superscript' | 'code' | 'mark' | 'small' | 'big';

export interface ReaderContentStyle {
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  fontStyle?: string;
  color?: string;
  backgroundColor?: string;
  textDecoration?: string;
  textTransform?: string;
  textAlign?: string;
  textIndent?: string;
  lineHeight?: string;
  letterSpacing?: string;
  wordSpacing?: string;
  whiteSpace?: string;
  verticalAlign?: string;
  direction?: string;
  marginTop?: string;
  marginBottom?: string;
  margin?: string;
  marginLeft?: string;
  marginRight?: string;
  marginInlineStart?: string;
  marginInlineEnd?: string;
  paddingTop?: string;
  paddingBottom?: string;
  paddingInlineStart?: string;
  paddingInlineEnd?: string;
  padding?: string;
  paddingLeft?: string;
  paddingRight?: string;
  display?: string;
  width?: string;
  maxWidth?: string;
  minWidth?: string;
  height?: string;
  maxHeight?: string;
  objectFit?: string;
  objectPosition?: string;
  borderTop?: string;
  borderBottom?: string;
  borderColor?: string;
  borderWidth?: string;
  borderStyle?: string;
  listStyleType?: string;
  float?: string;
  clear?: string;
}

export interface ReaderTextRun {
  type: 'text';
  text: string;
  marks: ReaderInlineMark[];
  style?: ReaderContentStyle;
  href?: string;
  title?: string;
  lineBreakBefore?: boolean;
}

export interface ReaderInlineImage {
  type: 'image';
  src: string;
  alt: string;
  title?: string;
  style?: ReaderContentStyle;
}

export type ReaderInlineContent = ReaderTextRun | ReaderInlineImage;

export interface ReaderParagraphBlock {
  type: 'paragraph';
  paragraphIndex: number;
  blockType: 'paragraph' | 'heading' | 'blockquote' | 'list-item' | 'verse' | 'pre' | 'caption' | 'table-row';
  level?: number;
  listMarker?: string;
  anchorIds?: string[];
  style?: ReaderContentStyle;
  content: ReaderInlineContent[];
}

export interface ReaderImageBlock {
  type: 'image';
  anchorIds?: string[];
  afterParagraphIndex: number;
  src: string;
  alt: string;
  title?: string;
  style?: ReaderContentStyle;
}

export interface ReaderRuleBlock {
  type: 'rule';
  anchorIds?: string[];
  afterParagraphIndex: number;
  style?: ReaderContentStyle;
}

export interface ReaderSpacerBlock {
  type: 'spacer';
  afterParagraphIndex: number;
  anchorIds?: string[];
  style?: ReaderContentStyle;
}

export type ReaderContentBlock = ReaderParagraphBlock | ReaderImageBlock | ReaderRuleBlock | ReaderSpacerBlock;

export interface BookChapter {
  title: string;
  paragraphs: string[];
  readerBlocks?: ReaderContentBlock[];
  titlePresentation?: 'content' | 'generated' | 'continuation';
  linear?: boolean;
}

export interface ImportedBook {
  id: string;
  title: string;
  author: string;
  sourceType: 'txt' | 'epub' | 'fb2' | 'pdf';
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
  definitionIds?: string[];
  source?: 'wordnet';
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
