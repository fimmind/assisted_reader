import type { WsdContext } from './wsd-filter';

export interface WsdModelStatus {
  phase: 'idle' | 'downloading' | 'loading' | 'ready' | 'error';
  downloadedBytes: number;
  totalBytes: number;
  message: string;
}

export type WsdRequestPriority = 'card' | 'popup';

interface PendingScore {
  key: string;
  resolve: (scores: number[]) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

const listeners = new Set<(status: WsdModelStatus) => void>();
const pending = new Map<number, PendingScore>();
const scoreCache = new Map<string, number[]>();
const ignoredResponses = new Set<number>();
const MAX_CACHED_SCORES = 100;

let worker: Worker | null = null;
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

function rejectPending(error: Error): void {
  for (const request of pending.values()) {
    request.signal.removeEventListener('abort', request.onAbort);
    request.reject(error);
  }
  pending.clear();
  ignoredResponses.clear();
}

function failWorker(error: Error): void {
  publishStatus({ phase: 'error', downloadedBytes: 0, totalBytes: 0, message: error.message });
  rejectPending(error);
  worker?.terminate();
  worker = null;
}

function handleWorkerMessage(event: MessageEvent<unknown>): void {
  if (!event.data || typeof event.data !== 'object') {
    throw new TypeError('Invalid WSD worker response.');
  }
  const message = event.data as Record<string, unknown>;
  if (message.type === 'status') {
    publishStatus(parseStatus(message));
    return;
  }
  if (typeof message.id !== 'number') {
    throw new TypeError(`WSD worker response has no request ID: type=${String(message.type)}`);
  }
  if (message.type === 'canceled') {
    ignoredResponses.delete(message.id);
    return;
  }
  const request = pending.get(message.id);
  if (!request) {
    if (ignoredResponses.delete(message.id)) {
      return;
    }
    throw new Error(`Unknown WSD worker request ID: id=${message.id}`);
  }
  pending.delete(message.id);
  request.signal.removeEventListener('abort', request.onAbort);
  if (message.type === 'scores' && Array.isArray(message.scores)
    && message.scores.every((score) => typeof score === 'number' && Number.isFinite(score))) {
    const scores = message.scores as number[];
    scoreCache.set(request.key, scores);
    if (scoreCache.size > MAX_CACHED_SCORES) {
      const oldest = scoreCache.keys().next().value;
      if (typeof oldest === 'string') {
        scoreCache.delete(oldest);
      }
    }
    request.resolve(scores);
  } else if (message.type === 'error' && typeof message.message === 'string') {
    request.reject(new Error(message.message));
  } else {
    request.reject(new TypeError(`Invalid WSD worker response: type=${String(message.type)}`));
  }
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
    failWorker(new Error(`WSD worker crashed: ${event.message}`));
  };
  created.onmessageerror = (): void => {
    failWorker(new Error('WSD worker sent an unreadable message.'));
  };
  worker = created;
  return created;
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
  publishStatus({ phase: 'loading', downloadedBytes: 0, totalBytes: 0, message: 'Checking model files' });
  try {
    getWorker().postMessage({ type: 'prepare' });
  } catch (error) {
    failWorker(new Error(`WSD worker could not start: ${error instanceof Error ? error.message : String(error)}`));
  }
}

export function stopWsdModel(): void {
  if (worker) {
    worker.onmessage = null;
    worker.terminate();
    worker = null;
  }
  rejectPending(new DOMException('WSD was disabled.', 'AbortError'));
  scoreCache.clear();
  ignoredResponses.clear();
  publishStatus({ phase: 'idle', downloadedBytes: 0, totalBytes: 0, message: 'Model not loaded' });
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
  const id = ++requestId;
  return new Promise<number[]>((resolve, reject) => {
    const onAbort = (): void => {
      pending.delete(id);
      ignoredResponses.add(id);
      worker?.postMessage({ type: 'cancel', id });
      reject(new DOMException('WSD request was canceled.', 'AbortError'));
    };
    pending.set(id, { key, resolve, reject, signal, onAbort });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      getWorker().postMessage({ type: 'score', id, context, glosses, priority });
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
