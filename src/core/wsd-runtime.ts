import type { WsdContext } from './wsd-filter';

export interface WsdModelStatus {
  phase: 'idle' | 'downloading' | 'loading' | 'ready' | 'error';
  downloadedBytes: number;
  totalBytes: number;
  message: string;
}

export type WsdRequestPriority = 'card' | 'visible-card' | 'popup';

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
  priority: WsdRequestPriority;
  subscribers: Set<ScoreSubscriber>;
}

const listeners = new Set<(status: WsdModelStatus) => void>();
const jobsByKey = new Map<string, ScoreJob>();
const queuedJobs: ScoreJob[] = [];
const scoreCache = new Map<string, number[]>();
const MAX_CACHED_SCORES = 100;

let worker: Worker | null = null;
let activeJob: ScoreJob | null = null;
let requestId = 0;
let status: WsdModelStatus = {
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
  publishStatus({ phase: 'error', downloadedBytes: 0, totalBytes: 0, message: error.message });
}

function dispatchNextJob(): void {
  if (activeJob || status.phase !== 'ready' || queuedJobs.length === 0) {
    return;
  }
  const popupIndex = queuedJobs.findIndex((job) => job.priority === 'popup');
  const visibleIndex = queuedJobs.findIndex((job) => job.priority === 'visible-card');
  const index = popupIndex >= 0 ? popupIndex : visibleIndex >= 0 ? visibleIndex : 0;
  const [job] = queuedJobs.splice(index, 1);
  if (!job || !worker) {
    failWorker(new Error('WSD worker is missing while a score request is queued.'));
    return;
  }
  activeJob = job;
  try {
    worker.postMessage({ type: 'score', id: job.id, context: job.context, glosses: job.glosses, priority: job.priority === 'popup' ? 'popup' : 'card' });
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
    scoreCache.set(job.key, scores);
    if (scoreCache.size > MAX_CACHED_SCORES) {
      const oldest = scoreCache.keys().next().value;
      if (typeof oldest === 'string') {
        scoreCache.delete(oldest);
      }
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

function getWorker(): Worker {
  if (worker) {
    return worker;
  }
  const created = new Worker(new URL('../workers/ettin-wsd.worker.ts', import.meta.url), { type: 'module' });
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

export function startWsdModel(): void {
  if (status.phase === 'ready' || status.phase === 'downloading' || status.phase === 'loading') {
    return;
  }
  terminateWorker();
  publishStatus({ phase: 'loading', downloadedBytes: 0, totalBytes: 0, message: 'Checking model files' });
  try {
    getWorker().postMessage({ type: 'prepare' });
  } catch (error) {
    failWorker(new Error(`WSD worker could not start: ${error instanceof Error ? error.message : String(error)}`));
  }
}

export function stopWsdModel(): void {
  terminateWorker();
  rejectAllJobs(new DOMException('WSD was disabled.', 'AbortError'));
  scoreCache.clear();
  publishStatus({ phase: 'idle', downloadedBytes: 0, totalBytes: 0, message: 'Model not loaded' });
}

export function promoteWsdWordSenses(context: WsdContext, glosses: string[]): void {
  const key = JSON.stringify([context, glosses]);
  const job = jobsByKey.get(key);
  if (job && job.priority === 'card') {
    job.priority = 'visible-card';
  }
}

export function scoreWordSenses(
  context: WsdContext,
  glosses: string[],
  priority: WsdRequestPriority,
  signal: AbortSignal,
): Promise<number[]> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('WSD request was canceled.', 'AbortError'));
  }
  if (status.phase !== 'ready') {
    return Promise.reject(new Error(`WSD model is not ready: phase=${status.phase} message=${status.message}`));
  }
  const key = JSON.stringify([context, glosses]);
  const cached = scoreCache.get(key);
  if (cached) {
    scoreCache.delete(key);
    scoreCache.set(key, cached);
    return Promise.resolve(cached);
  }
  let job = jobsByKey.get(key);
  if (!job) {
    job = { id: ++requestId, key, context, glosses, priority, subscribers: new Set<ScoreSubscriber>() };
    jobsByKey.set(key, job);
    queuedJobs.push(job);
  } else if (priority === 'popup' || (priority === 'visible-card' && job.priority === 'card')) {
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
