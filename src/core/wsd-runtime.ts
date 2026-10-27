import { wordNetDefinitionIds, wordNetGlosses } from './wsd-filter';
import type { WsdContext } from './wsd-filter';
import type { LexiconEntry, WsdMode } from './types';

type ActiveWsdMode = Exclude<WsdMode, 'none'>;

export interface WsdModelStatus {
  mode: WsdMode;
  phase: 'idle' | 'downloading' | 'loading' | 'ready' | 'error';
  downloadedBytes: number;
  totalBytes: number;
  message: string;
}

export type WsdRequestPriority = 'card' | 'visible-card' | 'popup' | 'preload';

interface ScoreSubscriber {
  resolve: (scores: number[]) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

interface ScoreJob {
  id: number;
  key: string;
  context: WsdContext;
  glosses: string[];
  word: string;
  senseIds: string[];
  priority: WsdRequestPriority;
  subscribers: Set<ScoreSubscriber>;
}

const listeners = new Set<(status: WsdModelStatus) => void>();
const jobsByKey = new Map<string, ScoreJob>();
const queuedJobs: ScoreJob[] = [];
const scoreCache = new Map<string, number[]>();
// Keep the next opening's scores from being evicted by the rest of the current chapter.
const preloadedScoreCache = new Map<string, number[]>();
const MAX_CACHED_SCORES = 100;
const PERSISTED_SCORE_CACHE_KEY = 'easeword-wsd-score-cache-v1';
const MODEL_CACHE_IDENTITIES: Record<ActiveWsdMode, string> = {
  sayedshaun: '54e41c09c61ae8bd60c62e40bf483141c49ce0d3:684639e685d709b7ece92fb2f41c1c811b7fe2ec316403b82082130d98d0c11a',
  'glite-lens': 'glite-lens-seed42-context-int8-v1:684639e685d709b7ece92fb2f41c1c811b7fe2ec316403b82082130d98d0c11a',
};

interface PersistedScoreEntry {
  key: string;
  scores: number[];
}

let persistedScoreCache: Map<string, PersistedScoreEntry> | null = null;

let worker: Worker | null = null;
let activeMode: WsdMode = 'none';
let activeJob: ScoreJob | null = null;
let requestId = 0;
let status: WsdModelStatus = {
  mode: 'none',
  phase: 'idle',
  downloadedBytes: 0,
  totalBytes: 0,
  message: 'Model not loaded',
};

function publishStatus(next: WsdModelStatus): void {
  status = next;
  for (const listener of listeners) {
    listener(status);
  }
}

function isPersistedScoreEntry(value: unknown): value is PersistedScoreEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const entry = value as Partial<PersistedScoreEntry>;
  return typeof entry.key === 'string' && entry.key.length <= 100_000
    && Array.isArray(entry.scores) && entry.scores.length <= 10_000
    && entry.scores.every((score) => typeof score === 'number' && Number.isFinite(score));
}

function getPersistedScoreCache(): Map<string, PersistedScoreEntry> {
  if (persistedScoreCache) {
    return persistedScoreCache;
  }
  persistedScoreCache = new Map<string, PersistedScoreEntry>();
  if (typeof localStorage === 'undefined') {
    return persistedScoreCache;
  }
  let raw: string | null;
  try {
    raw = localStorage.getItem(PERSISTED_SCORE_CACHE_KEY);
  } catch (error) {
    console.error('wsd-score-cache-read-failed', { storageKey: PERSISTED_SCORE_CACHE_KEY, error });
    throw error;
  }
  if (!raw) {
    return persistedScoreCache;
  }
  try {
    if (raw.length > 1_000_000) {
      throw new RangeError(`WSD score cache exceeds the storage limit: characters=${raw.length}`);
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new TypeError('WSD score cache must contain an array.');
    }
    for (const value of parsed) {
      if (!isPersistedScoreEntry(value)) {
        throw new TypeError(`Invalid saved WSD score entry in ${PERSISTED_SCORE_CACHE_KEY}.`);
      }
      persistedScoreCache.set(value.key, value);
    }
    while (persistedScoreCache.size > MAX_CACHED_SCORES) {
      const oldest = persistedScoreCache.keys().next().value;
      if (typeof oldest === 'string') {
        persistedScoreCache.delete(oldest);
      }
    }
    return persistedScoreCache;
  } catch (error) {
    persistedScoreCache = null;
    console.error('wsd-score-cache-parse-failed', { storageKey: PERSISTED_SCORE_CACHE_KEY, error });
    throw error;
  }
}

function savePersistedScoreCache(): void {
  if (typeof localStorage === 'undefined' || !persistedScoreCache) {
    return;
  }
  const cache = persistedScoreCache;
  while (cache.size > MAX_CACHED_SCORES) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== 'string') {
      break;
    }
    cache.delete(oldest);
  }
  let serialized = JSON.stringify([...cache.values()]);
  while (serialized.length > 1_000_000 && cache.size > 0) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== 'string') {
      break;
    }
    cache.delete(oldest);
    serialized = JSON.stringify([...cache.values()]);
  }
  try {
    localStorage.setItem(PERSISTED_SCORE_CACHE_KEY, serialized);
  } catch (error) {
    console.error('wsd-score-cache-save-failed', { storageKey: PERSISTED_SCORE_CACHE_KEY, characters: serialized.length, error });
    throw error;
  }
}

function scoreCacheKey(
  mode: ActiveWsdMode,
  context: WsdContext,
  entry: LexiconEntry,
  glosses: string[],
  senseIds: string[],
): string {
  return JSON.stringify([mode, MODEL_CACHE_IDENTITIES[mode], context, entry.word, glosses, senseIds]);
}

function rememberPersistedScores(key: string, scores: number[]): void {
  const cache = getPersistedScoreCache();
  cache.delete(key);
  cache.set(key, { key, scores });
  savePersistedScoreCache();
}

function touchCachedScores(cache: Map<string, number[]>, key: string, scores: number[]): void {
  cache.delete(key);
  cache.set(key, scores);
}

export function getCachedWordSenseScores(mode: ActiveWsdMode, context: WsdContext, entry: LexiconEntry): number[] | null {
  const glosses = wordNetGlosses(entry);
  const key = scoreCacheKey(mode, context, entry, glosses, wordNetDefinitionIds(entry));
  const memoryCache = preloadedScoreCache.has(key) ? preloadedScoreCache : scoreCache;
  const memoryScores = memoryCache.get(key);
  if (memoryScores) {
    touchCachedScores(memoryCache, key, memoryScores);
    return memoryScores.length === glosses.length ? memoryScores : null;
  }
  const persisted = getPersistedScoreCache().get(key);
  if (!persisted) {
    return null;
  }
  if (persisted.scores.length !== glosses.length) {
    getPersistedScoreCache().delete(key);
    return null;
  }
  const persistentCache = getPersistedScoreCache();
  persistentCache.delete(key);
  persistentCache.set(key, persisted);
  touchCachedScores(memoryCache, key, persisted.scores);
  return persisted.scores;
}

function parseStatus(message: Record<string, unknown>): WsdModelStatus {
  const phase = message.phase;
  if (phase !== 'downloading' && phase !== 'loading' && phase !== 'ready' && phase !== 'error') {
    throw new TypeError(`Invalid WSD model phase: ${String(phase)}`);
  }
  if (typeof message.downloadedBytes !== 'number' || typeof message.totalBytes !== 'number'
    || typeof message.message !== 'string') {
    throw new TypeError('Invalid WSD model status payload.');
  }
  return {
    mode: activeMode,
    phase,
    downloadedBytes: message.downloadedBytes,
    totalBytes: message.totalBytes,
    message: message.message,
  };
}

function resolveJob(job: ScoreJob, scores: number[]): void {
  for (const subscriber of job.subscribers) {
    subscriber.signal.removeEventListener('abort', subscriber.onAbort);
    subscriber.resolve(scores);
  }
  job.subscribers.clear();
}

function rejectJob(job: ScoreJob, error: Error): void {
  for (const subscriber of job.subscribers) {
    subscriber.signal.removeEventListener('abort', subscriber.onAbort);
    subscriber.reject(error);
  }
  job.subscribers.clear();
}

function rejectAllJobs(error: Error): void {
  for (const job of jobsByKey.values()) {
    rejectJob(job, error);
  }
  jobsByKey.clear();
  queuedJobs.length = 0;
  activeJob = null;
}

function terminateWorker(): void {
  if (worker) {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
    worker = null;
  }
}

function failWorker(error: Error): void {
  terminateWorker();
  rejectAllJobs(error);
  scoreCache.clear();
  preloadedScoreCache.clear();
  publishStatus({ mode: activeMode, phase: 'error', downloadedBytes: 0, totalBytes: 0, message: error.message });
}

function dispatchNextJob(): void {
  if (activeJob || status.phase !== 'ready' || queuedJobs.length === 0) {
    return;
  }
  const popupIndex = queuedJobs.findIndex((job) => job.priority === 'popup');
  const visibleIndex = queuedJobs.findIndex((job) => job.priority === 'visible-card');
  const preloadIndex = queuedJobs.findIndex((job) => job.priority === 'preload');
  const index = popupIndex >= 0 ? popupIndex : visibleIndex >= 0 ? visibleIndex : preloadIndex >= 0 ? preloadIndex : 0;
  const [job] = queuedJobs.splice(index, 1);
  if (!job || !worker) {
    failWorker(new Error('WSD worker is missing while a score request is queued.'));
    return;
  }
  activeJob = job;
  try {
    worker.postMessage({ type: 'score', id: job.id, context: job.context, glosses: job.glosses,
      word: job.word, senseIds: job.senseIds, priority: job.priority === 'popup' ? 'popup' : 'card' });
  } catch (error) {
    failWorker(new Error(`WSD score request could not be sent: id=${job.id} error=${error instanceof Error ? error.message : String(error)}`));
  }
}

function handleScoreResponse(message: Record<string, unknown>): void {
  const job = activeJob;
  if (!job || message.id !== job.id) {
    throw new Error(`Unexpected WSD worker request ID: expected=${job?.id} actual=${String(message.id)}`);
  }
  activeJob = null;
  if (jobsByKey.get(job.key) === job) {
    jobsByKey.delete(job.key);
  }
  if (job.subscribers.size === 0) {
    dispatchNextJob();
    return;
  }
  if (message.type === 'scores' && Array.isArray(message.scores)
    && message.scores.length === job.glosses.length
    && message.scores.every((score) => typeof score === 'number' && Number.isFinite(score))) {
    const scores = message.scores as number[];
    const cache = job.priority === 'preload' ? preloadedScoreCache : scoreCache;
    cache.set(job.key, scores);
    if (cache.size > MAX_CACHED_SCORES) {
      const oldest = cache.keys().next().value;
      if (typeof oldest === 'string') {
        cache.delete(oldest);
      }
    }
    try {
      rememberPersistedScores(job.key, scores);
    } catch (failure) {
      const error = failure instanceof Error ? failure : new Error(String(failure));
      rejectJob(job, error);
      throw error;
    }
    resolveJob(job, scores);
  } else if (message.type === 'error' && typeof message.message === 'string') {
    rejectJob(job, new Error(message.message));
  } else {
    rejectJob(job, new TypeError(`Invalid WSD worker response: type=${String(message.type)} id=${job.id}`));
  }
  dispatchNextJob();
}

function handleWorkerMessage(event: MessageEvent<unknown>): void {
  if (!event.data || typeof event.data !== 'object') {
    throw new TypeError('Invalid WSD worker response.');
  }
  const message = event.data as Record<string, unknown>;
  if (message.type === 'status') {
    const next = parseStatus(message);
    if (next.phase === 'error') {
      failWorker(new Error(next.message));
    } else {
      publishStatus(next);
      if (next.phase === 'ready') {
        dispatchNextJob();
      }
    }
    return;
  }
  if (typeof message.id !== 'number') {
    throw new TypeError(`WSD worker response has no request ID: type=${String(message.type)}`);
  }
  handleScoreResponse(message);
}

function getWorker(mode: ActiveWsdMode): Worker {
  if (worker) {
    return worker;
  }
  const created = mode === 'sayedshaun'
    ? new Worker(new URL('../workers/sayedshaun-wsd.worker.ts', import.meta.url), { type: 'module' })
    : new Worker(new URL('../workers/glite-lens.worker.ts', import.meta.url), { type: 'module' });
  created.onmessage = (event: MessageEvent<unknown>): void => {
    if (worker !== created) {
      return;
    }
    try {
      handleWorkerMessage(event);
    } catch (error) {
      failWorker(error instanceof Error ? error : new Error(String(error)));
    }
  };
  created.onerror = (event: ErrorEvent): void => {
    if (worker === created) {
      failWorker(new Error(`WSD worker crashed: ${event.message}`));
    }
  };
  created.onmessageerror = (): void => {
    if (worker === created) {
      failWorker(new Error('WSD worker sent an unreadable message.'));
    }
  };
  worker = created;
  return created;
}

function removeSubscriber(job: ScoreJob, subscriber: ScoreSubscriber): void {
  job.subscribers.delete(subscriber);
  subscriber.signal.removeEventListener('abort', subscriber.onAbort);
  subscriber.reject(new DOMException('WSD request was canceled.', 'AbortError'));
  if (job.subscribers.size > 0) {
    return;
  }
  if (jobsByKey.get(job.key) === job) {
    jobsByKey.delete(job.key);
  }
  if (activeJob === job) {
    try {
      if (!worker) {
        throw new Error('WSD worker is missing while canceling an active request.');
      }
      worker.postMessage({ type: 'cancel', id: job.id });
    } catch (error) {
      failWorker(new Error(`WSD cancellation could not be sent: id=${job.id} error=${error instanceof Error ? error.message : String(error)}`));
    }
  } else {
    const index = queuedJobs.indexOf(job);
    if (index >= 0) {
      queuedJobs.splice(index, 1);
    }
  }
}

export function getWsdModelStatus(): WsdModelStatus {
  return status;
}

export function subscribeWsdModelStatus(listener: (status: WsdModelStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function waitForWsdModelReady(mode: ActiveWsdMode, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('WSD request was canceled.', 'AbortError'));
  }
  if (activeMode !== mode || status.phase === 'idle') {
    startWsdModel(mode);
  }
  if (status.phase === 'ready' && status.mode === mode) {
    return Promise.resolve();
  }
  if (status.phase === 'error') {
    return Promise.reject(new Error(`WSD model failed to load: ${status.message}`));
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      unsubscribe();
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException('WSD request was canceled.', 'AbortError'));
    };
    const unsubscribe = subscribeWsdModelStatus((next) => {
      if (next.mode !== mode) {
        cleanup();
        reject(new DOMException('WSD model changed.', 'AbortError'));
      } else if (next.phase === 'ready') {
        cleanup();
        resolve();
      } else if (next.phase === 'error') {
        cleanup();
        reject(new Error(`WSD model failed to load: ${next.message}`));
      }
    });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function startWsdModel(mode: ActiveWsdMode): void {
  if (activeMode === mode && (status.phase === 'ready' || status.phase === 'downloading' || status.phase === 'loading')) {
    return;
  }
  terminateWorker();
  rejectAllJobs(new DOMException('WSD model changed.', 'AbortError'));
  scoreCache.clear();
  preloadedScoreCache.clear();
  activeMode = mode;
  publishStatus({ mode, phase: 'loading', downloadedBytes: 0, totalBytes: 0, message: 'Checking model files' });
  try {
    getWorker(mode).postMessage({ type: 'prepare' });
  } catch (error) {
    failWorker(new Error(`WSD worker could not start: ${error instanceof Error ? error.message : String(error)}`));
  }
}

export function stopWsdModel(): void {
  terminateWorker();
  rejectAllJobs(new DOMException('WSD was disabled.', 'AbortError'));
  scoreCache.clear();
  preloadedScoreCache.clear();
  activeMode = 'none';
  publishStatus({ mode: 'none', phase: 'idle', downloadedBytes: 0, totalBytes: 0, message: 'Model not loaded' });
}

export function promoteWsdWordSenses(context: WsdContext, entry: LexiconEntry): void {
  if (activeMode === 'none') {
    return;
  }
  const key = scoreCacheKey(activeMode, context, entry, wordNetGlosses(entry), wordNetDefinitionIds(entry));
  const job = jobsByKey.get(key);
  if (job && (job.priority === 'card' || job.priority === 'preload')) {
    job.priority = 'visible-card';
  }
}

export function scoreWordSenses(
  mode: ActiveWsdMode,
  context: WsdContext,
  entry: LexiconEntry,
  priority: WsdRequestPriority,
  signal: AbortSignal,
): Promise<number[]> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('WSD request was canceled.', 'AbortError'));
  }
  const glosses = wordNetGlosses(entry);
  const senseIds = wordNetDefinitionIds(entry);
  const key = scoreCacheKey(mode, context, entry, glosses, senseIds);
  const cached = getCachedWordSenseScores(mode, context, entry);
  if (cached) {
    return Promise.resolve(cached);
  }
  if (status.phase !== 'ready' || status.mode !== mode) {
    return Promise.reject(new Error(`WSD model is not ready: mode=${mode} active=${status.mode} phase=${status.phase} message=${status.message}`));
  }
  let job = jobsByKey.get(key);
  if (!job) {
    job = { id: ++requestId, key, context, glosses, word: entry.word, senseIds, priority, subscribers: new Set<ScoreSubscriber>() };
    jobsByKey.set(key, job);
    queuedJobs.push(job);
  } else if (priority === 'popup' || (priority === 'visible-card' && job.priority !== 'popup')
    || (priority === 'preload' && job.priority === 'card')) {
    job.priority = priority;
  }
  const active = job;
  const result = new Promise<number[]>((resolve, reject) => {
    const subscriber: ScoreSubscriber = {
      resolve,
      reject,
      signal,
      onAbort: () => removeSubscriber(active, subscriber),
    };
    active.subscribers.add(subscriber);
    signal.addEventListener('abort', subscriber.onAbort, { once: true });
  });
  dispatchNextJob();
  return result;
}
