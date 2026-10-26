import compromise from 'compromise';
import { buildResumableBookLemmaHistogramAsync } from '../core/reader-analysis';
import type { NlpLike } from '../core/nlp';
import type {
  BookHistogramWorkerCommand,
  BookHistogramWorkerMessage,
  BookHistogramWorkerOperationMessage,
} from '../core/book-histogram-worker-protocol';
import type { BookLemmaHistogramSegment } from '../core/reader-analysis';
import type { BookChapter, VocabularyModel } from '../core/types';

interface WorkerScope {
  onmessage: ((event: MessageEvent<BookHistogramWorkerCommand>) => void) | null;
  postMessage: (message: BookHistogramWorkerMessage) => void;
}

interface PendingOperation {
  resolve: (continueAnalysis: boolean) => void;
  reject: (error: Error) => void;
}

const workerScope = globalThis as unknown as WorkerScope;
const nlp = compromise as NlpLike;
let activeRunId: number | null = null;
let model: VocabularyModel | null = null;
let lemmaDict: Record<string, string> | null = null;
let lemmaCandidateCache = new Map<string, string[]>();
let activeChapterIndex: number | null = null;
let canceled = false;
let nextRequestId = 0;
const pendingOperations = new Map<number, PendingOperation>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function postFailure(runId: number, chapterIndex: number | null, error: unknown): void {
  workerScope.postMessage({
    type: 'failure',
    runId,
    chapterIndex,
    error: errorMessage(error),
  });
}

function handleInitialize(command: Extract<BookHistogramWorkerCommand, { type: 'initialize' }>): void {
  if (activeRunId !== null) {
    throw new Error(`Histogram worker was initialized twice: activeRunId=${activeRunId} nextRunId=${command.runId}`);
  }
  activeRunId = command.runId;
  model = command.model;
  lemmaDict = command.lemmaDict;
  lemmaCandidateCache = new Map<string, string[]>();
  workerScope.postMessage({ type: 'ready', runId: command.runId });
}

function handleOperationResult(
  command: Extract<BookHistogramWorkerCommand, { type: 'operation-result' }>,
): void {
  if (command.runId !== activeRunId) {
    throw new Error(`Histogram worker received a stale operation result: activeRunId=${String(activeRunId)} receivedRunId=${command.runId}`);
  }
  const pending = pendingOperations.get(command.requestId);
  if (!pending) {
    throw new Error(`Histogram worker received an unknown operation result: requestId=${command.requestId}`);
  }
  pendingOperations.delete(command.requestId);
  if (!command.ok) {
    pending.reject(new Error(command.error ?? `Histogram worker operation failed: requestId=${command.requestId}`));
    return;
  }
  const shouldContinue = command.continueAnalysis === true;
  if (!shouldContinue) {
    canceled = true;
  }
  pending.resolve(shouldContinue);
}

function requestMain(
  operation: Omit<BookHistogramWorkerOperationMessage, 'requestId'>,
): Promise<boolean> {
  nextRequestId += 1;
  const requestId = nextRequestId;
  const message: BookHistogramWorkerOperationMessage = { ...operation, requestId };
  return new Promise<boolean>((resolve, reject) => {
    pendingOperations.set(requestId, { resolve, reject });
    try {
      workerScope.postMessage(message);
    } catch (error) {
      pendingOperations.delete(requestId);
      reject(new Error(`Histogram worker could not send operation: runId=${operation.runId} operation=${operation.operation}`, { cause: error }));
    }
  });
}

async function analyzeChapter(
  runId: number,
  chapterIndex: number,
  chapter: BookChapter,
  savedSegments: BookLemmaHistogramSegment[],
): Promise<void> {
  if (activeRunId !== runId || !model || !lemmaDict) {
    throw new Error(`Histogram worker is not initialized for chapter: runId=${runId} chapterIndex=${chapterIndex}`);
  }
  if (activeChapterIndex !== null) {
    throw new Error(`Histogram worker received concurrent chapter jobs: activeChapterIndex=${activeChapterIndex} nextChapterIndex=${chapterIndex}`);
  }
  activeChapterIndex = chapterIndex;
  canceled = false;
  let processedUnits = 0;
  const totalUnits = chapter.paragraphs.length * 2;
  try {
    const histogram = await buildResumableBookLemmaHistogramAsync(
      { chapters: [chapter] },
      model,
      lemmaDict,
      nlp,
      savedSegments,
      lemmaCandidateCache,
      {
        shouldContinue: () => !canceled,
        onWorkUnitProcessed: (processed, total) => {
          processedUnits = processed;
          if (total !== totalUnits) {
            throw new RangeError(`Histogram worker progress total mismatch: chapterIndex=${chapterIndex} expected=${totalUnits} actual=${total}`);
          }
        },
        onYield: async () => {
          await requestMain({
            type: 'operation',
            runId,
            operation: 'yield',
            chapterIndex,
            processedUnits,
            totalUnits,
          });
        },
        saveSegment: async (segment) => {
          await requestMain({
            type: 'operation',
            runId,
            operation: 'save-segment',
            chapterIndex,
            segment,
          });
        },
        clearTaggedChapter: async () => {
          await requestMain({
            type: 'operation',
            runId,
            operation: 'clear-tagged-chapter',
            chapterIndex,
          });
        },
      },
    );
    workerScope.postMessage({ type: 'chapter-complete', runId, chapterIndex, histogram });
  } catch (error) {
    if (!canceled) {
      postFailure(runId, chapterIndex, error);
    }
  } finally {
    activeChapterIndex = null;
  }
}

function handleChapter(
  command: Extract<BookHistogramWorkerCommand, { type: 'analyze-chapter' }>,
): void {
  void analyzeChapter(command.runId, command.chapterIndex, command.chapter, command.savedSegments);
}

workerScope.onmessage = (event: MessageEvent<BookHistogramWorkerCommand>): void => {
  const command = event.data;
  try {
    if (command.type === 'initialize') {
      handleInitialize(command);
      return;
    }
    if (command.type === 'operation-result') {
      handleOperationResult(command);
      return;
    }
    if (command.type === 'analyze-chapter') {
      handleChapter(command);
      return;
    }
    const exhaustive: never = command;
    throw new TypeError(`Unknown histogram worker command: ${String(exhaustive)}`);
  } catch (error) {
    if (activeRunId !== null) {
      postFailure(activeRunId, activeChapterIndex, error);
      return;
    }
    throw error;
  }
};
