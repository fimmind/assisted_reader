import type { WsdContext } from './wsd-filter';

export interface WsdModelStatus {
  phase: 'idle' | 'downloading' | 'loading' | 'ready' | 'error';
  downloadedBytes: number;
  totalBytes: number;
  message: string;
}

interface PendingScore {
  resolve: (scores: number[]) => void;
  reject: (error: Error) => void;
}

const listeners = new Set<(status: WsdModelStatus) => void>();
const pending = new Map<number, PendingScore>();
const scoreCache = new Map<string, Promise<number[]>>();
const MAX_CACHED_SCORES = 100;

let worker: Worker | null = null;
let requestId = 0;
let status: WsdModelStatus = {
  phase: 'idle',
  downloadedBytes: 0,
  totalBytes: 0,
  message: 'Not downloaded',
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

function getWorker(): Worker {
  if (worker) {
    return worker;
  }
  worker = new Worker(new URL('../workers/ettin-wsd.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<unknown>): void => {
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
    const request = pending.get(message.id);
    if (!request) {
      throw new Error(`Unknown WSD worker request ID: id=${message.id}`);
    }
    pending.delete(message.id);
    if (message.type === 'scores' && Array.isArray(message.scores)
      && message.scores.every((score) => typeof score === 'number' && Number.isFinite(score))) {
      request.resolve(message.scores);
    } else if (message.type === 'error' && typeof message.message === 'string') {
      request.reject(new Error(message.message));
    } else {
      request.reject(new TypeError(`Invalid WSD worker response: type=${String(message.type)}`));
    }
  };
  worker.onerror = (event: ErrorEvent): void => {
    const error = new Error(`WSD worker crashed: ${event.message}`);
    publishStatus({ phase: 'error', downloadedBytes: 0, totalBytes: 0, message: error.message });
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
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
  getWorker().postMessage({ type: 'prepare' });
}

export function scoreWordSenses(context: WsdContext, glosses: string[]): Promise<number[]> {
  const key = JSON.stringify([context, glosses]);
  const cached = scoreCache.get(key);
  if (cached) {
    return cached;
  }
  startWsdModel();
  const id = ++requestId;
  const result = new Promise<number[]>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ type: 'score', id, context, glosses });
  });
  scoreCache.set(key, result);
  if (scoreCache.size > MAX_CACHED_SCORES) {
    const oldest = scoreCache.keys().next().value;
    if (typeof oldest === 'string') {
      scoreCache.delete(oldest);
    }
  }
  void result.catch(() => scoreCache.delete(key));
  return result;
}
