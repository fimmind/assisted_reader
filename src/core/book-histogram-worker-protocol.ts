import type { BookLemmaHistogram, BookLemmaHistogramSegment } from './reader-analysis';
import type { BookChapter, VocabularyModel } from './types';

export interface BookHistogramWorkerInitializeMessage {
  type: 'initialize';
  runId: number;
  model: VocabularyModel;
  lemmaDict: Record<string, string>;
}

export interface BookHistogramWorkerChapterMessage {
  type: 'analyze-chapter';
  runId: number;
  chapterIndex: number;
  chapter: BookChapter;
  savedSegments: BookLemmaHistogramSegment[];
}

export interface BookHistogramWorkerOperationResultMessage {
  type: 'operation-result';
  runId: number;
  requestId: number;
  ok: boolean;
  continueAnalysis?: boolean;
  error?: string;
}

export type BookHistogramWorkerCommand =
  | BookHistogramWorkerInitializeMessage
  | BookHistogramWorkerChapterMessage
  | BookHistogramWorkerOperationResultMessage;

export interface BookHistogramWorkerReadyMessage {
  type: 'ready';
  runId: number;
}

export interface BookHistogramWorkerOperationMessage {
  type: 'operation';
  runId: number;
  requestId: number;
  operation: 'yield' | 'save-segment' | 'clear-tagged-chapter';
  chapterIndex: number;
  processedUnits?: number;
  totalUnits?: number;
  segment?: BookLemmaHistogramSegment;
}

export interface BookHistogramWorkerChapterCompleteMessage {
  type: 'chapter-complete';
  runId: number;
  chapterIndex: number;
  histogram: BookLemmaHistogram | null;
}

export interface BookHistogramWorkerFailureMessage {
  type: 'failure';
  runId: number;
  chapterIndex: number | null;
  error: string;
}

export type BookHistogramWorkerMessage =
  | BookHistogramWorkerReadyMessage
  | BookHistogramWorkerOperationMessage
  | BookHistogramWorkerChapterCompleteMessage
  | BookHistogramWorkerFailureMessage;
