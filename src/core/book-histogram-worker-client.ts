import type {
  BookHistogramWorkerChapterCompleteMessage,
  BookHistogramWorkerCommand,
  BookHistogramWorkerInitializeMessage,
  BookHistogramWorkerMessage,
  BookHistogramWorkerOperationMessage,
  BookHistogramWorkerOperationResultMessage,
} from './book-histogram-worker-protocol';
import type {
  BookLemmaHistogram,
  BookLemmaHistogramSegment,
} from './reader-analysis';
import type { BookChapter, VocabularyModel } from './types';

export interface BookHistogramWorkerHooks {
  bookId: string;
  shouldContinue: () => boolean;
  loadSegments: () => Promise<BookLemmaHistogramSegment[]>;
  onWorkUnitProcessed: (processedUnits: number, totalUnits: number) => void;
  saveSegment: (segment: BookLemmaHistogramSegment) => Promise<void>;
  clearTaggedChapter: (chapterIndex: number) => Promise<void>;
}

interface ChapterJob {
  chapterIndex: number;
  chapter: BookChapter;
  savedSegments: BookLemmaHistogramSegment[];
}

interface ActiveChapter {
  chapterIndex: number;
  resolve: (histogram: BookLemmaHistogram | null) => void;
  reject: (error: Error) => void;
}

interface WorkerState {
  worker: Worker;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  readyResolved: boolean;
  activeChapter: ActiveChapter | null;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

interface ActiveBookHistogramRun {
  bookId: string;
  runId: number;
  hooks: BookHistogramWorkerHooks;
  workers: WorkerState[];
  pendingPersistence: Set<Promise<void>>;
  persistenceFailure: Error | null;
  canceled: boolean;
  failure: Error | null;
  chapterProgress: number[];
  chapterTotalUnits: number[];
  totalWorkUnits: number;
  finished: Promise<void>;
  resolveFinished: () => void;
}

const MAX_WORKER_COUNT = 2;
const WORKER_IDLE_TIMEOUT_MS = 60_000;

let nextRunId = 0;
const activeRunsByBookId = new Map<string, ActiveBookHistogramRun>();

function errorFromUnknown(error: unknown, context: string): Error {
  return error instanceof Error
    ? new Error(`${context}: ${error.message}`, { cause: error })
    : new Error(`${context}: ${String(error)}`);
}

function abortError(bookId: string, runId: number): Error {
  return new DOMException(`Book histogram analysis was canceled: bookId=${bookId} runId=${runId}`, 'AbortError');
}

function resolveWorkerCount(chapterCount: number): number {
  if (chapterCount <= 0) {
    return 0;
  }
  if (typeof Worker === 'undefined') {
    throw new Error('Book histogram analysis requires module workers in this browser.');
  }
  const coreCount = navigator.hardwareConcurrency;
  if (!Number.isInteger(coreCount) || coreCount < 1) {
    throw new Error(`Book histogram analysis requires a valid hardware concurrency value: actual=${String(coreCount)}`);
  }
  const availableWorkerCount = Math.max(1, coreCount - 1);
  return Math.min(MAX_WORKER_COUNT, availableWorkerCount, chapterCount);
}

function createWorkerState(run: ActiveBookHistogramRun): WorkerState {
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let worker: Worker;
  try {
    worker = new Worker(new URL('../workers/book-histogram.worker.ts', import.meta.url), { type: 'module' });
  } catch (error) {
    throw errorFromUnknown(error, `Could not start book histogram worker: bookId=${run.bookId} runId=${run.runId}`);
  }
  const state: WorkerState = {
    worker,
    ready,
    resolveReady,
    rejectReady,
    readyResolved: false,
    activeChapter: null,
    timeoutId: null,
  };
  worker.onmessage = (event: MessageEvent<BookHistogramWorkerMessage>): void => {
    void handleWorkerMessage(run, state, event.data).catch((error: unknown) => {
      failRun(run, errorFromUnknown(error, `Book histogram worker message failed: bookId=${run.bookId} runId=${run.runId}`));
    });
  };
  worker.onerror = (event: ErrorEvent): void => {
    failRun(run, new Error(`Book histogram worker crashed: bookId=${run.bookId} runId=${run.runId} message=${event.message}`));
  };
  worker.onmessageerror = (): void => {
    failRun(run, new Error(`Book histogram worker sent an unreadable message: bookId=${run.bookId} runId=${run.runId}`));
  };
  return state;
}

function armWorkerTimeout(run: ActiveBookHistogramRun, state: WorkerState): void {
  if (state.timeoutId !== null) {
    clearTimeout(state.timeoutId);
  }
  state.timeoutId = setTimeout(() => {
    const chapterIndex = state.activeChapter?.chapterIndex;
    failRun(
      run,
      new Error(`Book histogram worker timed out: bookId=${run.bookId} runId=${run.runId} chapterIndex=${String(chapterIndex)} timeoutMs=${WORKER_IDLE_TIMEOUT_MS}`),
    );
  }, WORKER_IDLE_TIMEOUT_MS);
}

function clearWorkerTimeout(state: WorkerState): void {
  if (state.timeoutId !== null) {
    clearTimeout(state.timeoutId);
    state.timeoutId = null;
  }
}

function postCommand(run: ActiveBookHistogramRun, state: WorkerState, command: BookHistogramWorkerCommand): void {
  if (run.canceled || run.failure) {
    throw run.failure ?? abortError(run.bookId, run.runId);
  }
  try {
    state.worker.postMessage(command);
    armWorkerTimeout(run, state);
  } catch (error) {
    const chapterIndex = state.activeChapter?.chapterIndex;
    throw errorFromUnknown(
      error,
      `Could not send book histogram worker command: bookId=${run.bookId} runId=${run.runId} chapterIndex=${String(chapterIndex)} type=${command.type}`,
    );
  }
}

function workerCommandResult(
  run: ActiveBookHistogramRun,
  state: WorkerState,
  request: BookHistogramWorkerOperationMessage,
  result: Omit<BookHistogramWorkerOperationResultMessage, 'type' | 'runId' | 'requestId'>,
): void {
  const command: BookHistogramWorkerOperationResultMessage = {
    type: 'operation-result',
    runId: run.runId,
    requestId: request.requestId,
    ...result,
  };
  postCommand(run, state, command);
}

function reportChapterProgress(
  run: ActiveBookHistogramRun,
  chapterProgress: number[],
  chapterTotalUnitsByIndex: number[],
  totalWorkUnits: number,
  chapterIndex: number,
  processedUnits: number,
  totalChapterUnits: number,
): void {
  if (!Number.isInteger(processedUnits) || !Number.isInteger(totalChapterUnits)
    || processedUnits < 0 || totalChapterUnits !== chapterTotalUnitsByIndex[chapterIndex]
    || processedUnits > totalChapterUnits) {
    throw new RangeError(`Invalid book histogram worker progress: bookId=${run.bookId} runId=${run.runId} chapterIndex=${chapterIndex} processed=${processedUnits} total=${totalChapterUnits}`);
  }
  chapterProgress[chapterIndex] = Math.max(chapterProgress[chapterIndex] ?? 0, processedUnits);
  const totalProcessedUnits = chapterProgress.reduce((total, current) => total + current, 0);
  run.hooks.onWorkUnitProcessed(totalProcessedUnits, totalWorkUnits);
}

function canonicalSegment(
  segment: BookLemmaHistogramSegment,
  chapterIndex: number,
): BookLemmaHistogramSegment {
  if (segment.chapterIndex !== 0) {
    throw new RangeError(`Worker returned a nonlocal checkpoint index: expected=0 actual=${segment.chapterIndex}`);
  }
  return { ...segment, chapterIndex };
}

async function persistWorkerOperation(
  run: ActiveBookHistogramRun,
  state: WorkerState,
  request: BookHistogramWorkerOperationMessage,
): Promise<void> {
  if (!run.hooks.shouldContinue()) {
    cancelRun(run);
    return;
  }
  const chapter = state.activeChapter;
  if (!chapter || chapter.chapterIndex !== request.chapterIndex) {
    throw new Error(`Histogram worker operation has no active chapter: bookId=${run.bookId} runId=${run.runId} operation=${request.operation} chapterIndex=${request.chapterIndex}`);
  }
  if (request.operation === 'yield') {
    if (typeof request.processedUnits !== 'number' || typeof request.totalUnits !== 'number') {
      throw new TypeError(`Histogram worker yielded invalid progress: bookId=${run.bookId} runId=${run.runId} chapterIndex=${chapter.chapterIndex}`);
    }
    reportChapterProgress(
      run,
      run.chapterProgress,
      run.chapterTotalUnits,
      run.totalWorkUnits,
      chapter.chapterIndex,
      request.processedUnits,
      request.totalUnits,
    );
    if (!run.hooks.shouldContinue()) {
      cancelRun(run);
      return;
    }
    workerCommandResult(run, state, request, { ok: true, continueAnalysis: true });
    return;
  }

  const persistence = request.operation === 'save-segment'
    ? request.segment
      ? run.hooks.saveSegment(canonicalSegment(request.segment, chapter.chapterIndex))
      : Promise.reject(new TypeError(`Histogram worker omitted a checkpoint segment: bookId=${run.bookId} runId=${run.runId} chapterIndex=${chapter.chapterIndex}`))
    : run.hooks.clearTaggedChapter(chapter.chapterIndex);
  run.pendingPersistence.add(persistence);
  try {
    await persistence;
  } catch (error) {
    if (!(run.canceled && error instanceof DOMException && error.name === 'AbortError')) {
      const persistenceFailure = errorFromUnknown(
        error,
        `Book histogram checkpoint persistence failed: bookId=${run.bookId} runId=${run.runId} chapterIndex=${chapter.chapterIndex} operation=${request.operation}`,
      );
      run.persistenceFailure ??= persistenceFailure;
      throw persistenceFailure;
    }
  } finally {
    run.pendingPersistence.delete(persistence);
  }
  if (!run.hooks.shouldContinue()) {
    cancelRun(run);
    return;
  }
  workerCommandResult(run, state, request, { ok: true, continueAnalysis: true });
}

function resolveChapterResult(
  state: WorkerState,
  message: BookHistogramWorkerChapterCompleteMessage,
): void {
  const activeChapter = state.activeChapter;
  if (!activeChapter || activeChapter.chapterIndex !== message.chapterIndex) {
    throw new Error(`Histogram worker completed an unexpected chapter: expected=${String(activeChapter?.chapterIndex)} actual=${message.chapterIndex}`);
  }
  state.activeChapter = null;
  clearWorkerTimeout(state);
  activeChapter.resolve(message.histogram);
}

async function handleWorkerMessage(
  run: ActiveBookHistogramRun,
  state: WorkerState,
  message: BookHistogramWorkerMessage,
): Promise<void> {
  if (run.canceled || run.failure) {
    return;
  }
  if (message.runId !== run.runId) {
    throw new Error(`Book histogram worker sent a stale message: expectedRunId=${run.runId} actualRunId=${message.runId}`);
  }
  armWorkerTimeout(run, state);
  if (message.type === 'ready') {
    if (state.readyResolved) {
      throw new Error(`Book histogram worker sent duplicate readiness: bookId=${run.bookId} runId=${run.runId}`);
    }
    state.readyResolved = true;
    clearWorkerTimeout(state);
    state.resolveReady();
    return;
  }
  if (message.type === 'operation') {
    await persistWorkerOperation(run, state, message);
    return;
  }
  if (message.type === 'chapter-complete') {
    if (!message.histogram && run.hooks.shouldContinue()) {
      throw new Error(`Book histogram worker returned no result while analysis should continue: bookId=${run.bookId} runId=${run.runId} chapterIndex=${message.chapterIndex}`);
    }
    resolveChapterResult(state, message);
    return;
  }
  if (message.type === 'failure') {
    throw new Error(`Book histogram worker failed: bookId=${run.bookId} runId=${run.runId} chapterIndex=${String(message.chapterIndex)} error=${message.error}`);
  }
  const exhaustive: never = message;
  throw new TypeError(`Unknown book histogram worker message: ${String(exhaustive)}`);
}

function terminateWorkers(run: ActiveBookHistogramRun): void {
  for (const state of run.workers) {
    clearWorkerTimeout(state);
    state.worker.onmessage = null;
    state.worker.onerror = null;
    state.worker.onmessageerror = null;
    state.worker.terminate();
  }
}

function rejectWorkerState(state: WorkerState, error: Error): void {
  if (!state.readyResolved) {
    state.rejectReady(error);
    state.readyResolved = true;
  }
  if (state.activeChapter) {
    state.activeChapter.reject(error);
    state.activeChapter = null;
  }
}

function cancelRun(run: ActiveBookHistogramRun): void {
  if (run.canceled || run.failure) {
    return;
  }
  run.canceled = true;
  const error = abortError(run.bookId, run.runId);
  terminateWorkers(run);
  for (const state of run.workers) {
    rejectWorkerState(state, error);
  }
}

function failRun(run: ActiveBookHistogramRun, error: Error): void {
  if (run.canceled || run.failure) {
    return;
  }
  run.failure = error;
  terminateWorkers(run);
  for (const state of run.workers) {
    rejectWorkerState(state, error);
  }
}

function createRun(
  bookId: string,
  hooks: BookHistogramWorkerHooks,
): ActiveBookHistogramRun {
  let resolveFinished: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  nextRunId += 1;
  return {
    bookId,
    runId: nextRunId,
    hooks,
    workers: [],
    pendingPersistence: new Set<Promise<void>>(),
    persistenceFailure: null,
    canceled: false,
    failure: null,
    finished,
    resolveFinished,
    chapterProgress: [],
    chapterTotalUnits: [],
    totalWorkUnits: 0,
  };
}

async function initializeWorkers(
  run: ActiveBookHistogramRun,
  workerCount: number,
  model: VocabularyModel,
  lemmaDict: Record<string, string>,
): Promise<void> {
  try {
    for (let index = 0; index < workerCount; index += 1) {
      const state = createWorkerState(run);
      run.workers.push(state);
      // Attach rejection handling immediately; the original promise is still awaited below.
      void state.ready.catch(() => {});
    }
  } catch (error) {
    const failure = errorFromUnknown(error, `Could not create book histogram worker pool: bookId=${run.bookId} runId=${run.runId}`);
    failRun(run, failure);
    throw failure;
  }
  const initialize: BookHistogramWorkerInitializeMessage = {
    type: 'initialize',
    runId: run.runId,
    model,
    lemmaDict,
  };
  for (const state of run.workers) {
    postCommand(run, state, initialize);
  }
  await Promise.all(run.workers.map((state) => state.ready));
}

function segmentsForChapter(
  savedSegments: BookLemmaHistogramSegment[],
  chapterIndex: number,
): BookLemmaHistogramSegment[] {
  return savedSegments
    .filter((segment) => segment.chapterIndex === chapterIndex)
    .map((segment) => ({ ...segment, chapterIndex: 0 }));
}

function sumChapterHistograms(
  histograms: Array<BookLemmaHistogram | null>,
): BookLemmaHistogram {
  let totalTokenCount = 0;
  const lemmaCounts = new Map<string, number>();
  for (const histogram of histograms) {
    if (!histogram) {
      throw new TypeError('Book histogram worker completed without a chapter histogram.');
    }
    totalTokenCount += histogram.totalTokenCount;
    for (const [lemma, count] of Object.entries(histogram.nonProperLemmaCounts)) {
      lemmaCounts.set(lemma, (lemmaCounts.get(lemma) ?? 0) + count);
    }
  }
  return { totalTokenCount, nonProperLemmaCounts: Object.fromEntries(lemmaCounts) };
}

async function runWorkerLoop(
  run: ActiveBookHistogramRun,
  state: WorkerState,
  chapters: BookChapter[],
  savedSegments: BookLemmaHistogramSegment[],
  nextChapter: { index: number },
  results: Array<BookLemmaHistogram | null>,
): Promise<void> {
  while (!run.canceled && !run.failure && run.hooks.shouldContinue()) {
    const chapterIndex = nextChapter.index;
    nextChapter.index += 1;
    const chapter = chapters[chapterIndex];
    if (!chapter) {
      return;
    }
    const histogram = await new Promise<BookLemmaHistogram | null>((resolve, reject) => {
      state.activeChapter = { chapterIndex, resolve, reject };
      const command: BookHistogramWorkerCommand = {
        type: 'analyze-chapter',
        runId: run.runId,
        chapterIndex,
        chapter: { title: chapter.title, paragraphs: chapter.paragraphs },
        savedSegments: segmentsForChapter(savedSegments, chapterIndex),
      };
      postCommand(run, state, command);
    });
    if (run.canceled || run.failure || !run.hooks.shouldContinue()) {
      cancelRun(run);
      return;
    }
    if (!histogram) {
      throw new Error(`Book histogram worker canceled a chapter unexpectedly: bookId=${run.bookId} runId=${run.runId} chapterIndex=${chapterIndex}`);
    }
    results[chapterIndex] = histogram;
    run.chapterProgress[chapterIndex] = run.chapterTotalUnits[chapterIndex];
    run.hooks.onWorkUnitProcessed(
      run.chapterProgress.reduce((total, processed) => total + processed, 0),
      run.totalWorkUnits,
    );
  }
}

async function waitForPersistence(run: ActiveBookHistogramRun): Promise<void> {
  while (run.pendingPersistence.size > 0) {
    const results = await Promise.allSettled([...run.pendingPersistence]);
    for (const result of results) {
      if (result.status === 'rejected' && !run.persistenceFailure) {
        run.persistenceFailure = errorFromUnknown(
          result.reason,
          `Book histogram checkpoint persistence failed: bookId=${run.bookId} runId=${run.runId}`,
        );
      }
    }
  }
  if (run.persistenceFailure) {
    throw run.persistenceFailure;
  }
}

async function executeRun(
  run: ActiveBookHistogramRun,
  book: { chapters: BookChapter[] },
  model: VocabularyModel,
  lemmaDict: Record<string, string>,
  workerCount: number,
): Promise<BookLemmaHistogram | null> {
  const savedSegments = await run.hooks.loadSegments();
  if (run.canceled || !run.hooks.shouldContinue()) {
    cancelRun(run);
    return null;
  }
  const totalParagraphs = book.chapters.reduce((total, chapter) => total + chapter.paragraphs.length, 0);
  run.totalWorkUnits = totalParagraphs * 2;
  run.chapterProgress = book.chapters.map(() => 0);
  run.chapterTotalUnits = book.chapters.map((chapter) => chapter.paragraphs.length * 2);
  run.hooks.onWorkUnitProcessed(0, run.totalWorkUnits);
  if (book.chapters.length === 0) {
    return { totalTokenCount: 0, nonProperLemmaCounts: {} };
  }

  await initializeWorkers(run, workerCount, model, lemmaDict);
  if (run.canceled || !run.hooks.shouldContinue()) {
    cancelRun(run);
    return null;
  }

  const nextChapter = { index: 0 };
  const results: Array<BookLemmaHistogram | null> = book.chapters.map(() => null);
  await Promise.all(run.workers.map((state) =>
    runWorkerLoop(run, state, book.chapters, savedSegments, nextChapter, results)));
  if (run.canceled || run.failure || !run.hooks.shouldContinue()) {
    cancelRun(run);
    return null;
  }
  return sumChapterHistograms(results);
}

export async function buildBookLemmaHistogramWithWorkersAsync(
  book: { chapters: BookChapter[] },
  model: VocabularyModel,
  lemmaDict: Record<string, string>,
  hooks: BookHistogramWorkerHooks,
): Promise<BookLemmaHistogram | null> {
  const workerCount = resolveWorkerCount(book.chapters.length);
  const previousRun = activeRunsByBookId.get(hooks.bookId);
  if (previousRun) {
    cancelRun(previousRun);
    await previousRun.finished;
  }
  if (!hooks.shouldContinue()) {
    return null;
  }

  const run = createRun(hooks.bookId, hooks);
  activeRunsByBookId.set(hooks.bookId, run);
  try {
    return await executeRun(run, book, model, lemmaDict, workerCount);
  } catch (error) {
    if (run.canceled && error instanceof DOMException && error.name === 'AbortError') {
      return null;
    }
    const failure = errorFromUnknown(error, `Book histogram worker pool failed: bookId=${run.bookId} runId=${run.runId}`);
    failRun(run, failure);
    throw failure;
  } finally {
    terminateWorkers(run);
    try {
      await waitForPersistence(run);
    } finally {
      if (activeRunsByBookId.get(run.bookId) === run) {
        activeRunsByBookId.delete(run.bookId);
      }
      run.resolveFinished();
    }
  }
}
