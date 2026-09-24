import { Tokenizer } from '@huggingface/tokenizers';
import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import { buildWsdPrompt } from '../core/wsd-filter';
import type { WsdContext } from '../core/wsd-filter';

interface ModelPart {
  name: string;
  size: number;
  sha256: string;
}

interface ModelManifest {
  revision: string;
  size: number;
  parts: ModelPart[];
  metadata: Record<string, string>;
}

interface ScoreRequest {
  type: 'score';
  id: number;
  context: WsdContext;
  glosses: string[];
  priority: 'card' | 'popup';
}

type WorkerRequest = { type: 'prepare' } | { type: 'cancel'; id: number } | ScoreRequest;
type ModelPhase = 'downloading' | 'loading' | 'ready' | 'error';

const MODEL_BASE = `${import.meta.env.BASE_URL}wsd/ettin-150m-wsd/`;
const CACHE_NAME = 'easeword-ettin-150m-wsd-8751b577-uint8-v1';
const MODEL_REVISION = '8751b577199d1bb95b74fa2457da7065d57100ae';
const METADATA_FILES = ['tokenizer.json', 'tokenizer_config.json', 'answer_letters.json'] as const;
const MAX_TOKENS = 7999;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MANIFEST_TIMEOUT_MS = 20_000;
const METADATA_TIMEOUT_MS = 60_000;
const WASM_TIMEOUT_MS = 90_000;
const MAX_PARALLEL_MODEL_PARTS = 2;

let session: ort.InferenceSession | null = null;
let tokenizer: Tokenizer | null = null;
let letters: string[] | null = null;
let preparePromise: Promise<void> | null = null;
let preparationFailed = false;
let processing = false;
let activeId: number | null = null;
const canceled = new Set<number>();
const popupQueue: ScoreRequest[] = [];
const cardQueue: ScoreRequest[] = [];

function reportStatus(phase: ModelPhase, downloadedBytes: number, totalBytes: number, message: string): void {
  self.postMessage({ type: 'status', phase, downloadedBytes, totalBytes, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pauseBeforeRetry(attempt: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, attempt * 300));
}

async function fetchBytesOnce(url: string, timeoutMs: number): Promise<ArrayBuffer> {
  const response = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`WSD download failed: url=${url} status=${response.status} statusText=${response.statusText} body=${(await response.text()).slice(0, 500)}`);
  }
  return response.arrayBuffer();
}

async function fetchBytes(url: string, timeoutMs: number): Promise<ArrayBuffer> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetchBytesOnce(url, timeoutMs);
    } catch (error) {
      lastError = new Error(`WSD download attempt failed: url=${url} attempt=${attempt} error=${errorMessage(error)}`);
      console.warn('wsd-download-retry', { url, attempt, error: lastError });
      if (attempt < 3) {
        await pauseBeforeRetry(attempt);
      }
    }
  }
  throw lastError ?? new Error(`WSD download failed without an error: url=${url}`);
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fetchVerifiedBytes(url: string, expectedHash: string, timeoutMs: number): Promise<ArrayBuffer> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const bytes = await fetchBytesOnce(url, timeoutMs);
      const actualHash = await sha256(bytes);
      if (actualHash !== expectedHash) {
        throw new Error(`WSD checksum mismatch: url=${url} expected=${expectedHash} actual=${actualHash}`);
      }
      return bytes;
    } catch (error) {
      lastError = new Error(`WSD verified download failed: url=${url} attempt=${attempt} error=${errorMessage(error)}`);
      console.warn('wsd-download-retry', { url, attempt, error: lastError });
      if (attempt < 3) {
        await pauseBeforeRetry(attempt);
      }
    }
  }
  throw lastError ?? new Error(`WSD verified download failed without an error: url=${url}`);
}

function parseManifest(candidate: unknown): ModelManifest {
  if (!candidate || typeof candidate !== 'object') {
    throw new TypeError('Invalid WSD manifest: expected an object.');
  }
  const value = candidate as Record<string, unknown>;
  if (typeof value.revision !== 'string' || !Array.isArray(value.parts) || typeof value.size !== 'number') {
    throw new TypeError('Invalid WSD manifest: missing revision, size, or parts.');
  }
  if (value.revision !== MODEL_REVISION || !Number.isSafeInteger(value.size)
    || value.size <= 0 || value.size > 300_000_000 || value.parts.length === 0 || value.parts.length > 20) {
    throw new RangeError(`Unsupported WSD manifest: revision=${value.revision} size=${value.size} parts=${value.parts.length}`);
  }
  const parts: ModelPart[] = value.parts.map((item: unknown, index: number) => {
    if (!item || typeof item !== 'object') {
      throw new TypeError(`Invalid WSD model part: index=${index}`);
    }
    const part = item as Record<string, unknown>;
    if (part.name !== `model.part${String(index).padStart(2, '0')}`
      || typeof part.size !== 'number' || !Number.isSafeInteger(part.size) || part.size <= 0
      || typeof part.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(part.sha256)) {
      throw new TypeError(`Invalid WSD model part: name=${String(part.name)} size=${String(part.size)}`);
    }
    return { name: part.name, size: part.size, sha256: part.sha256 };
  });
  if (parts.reduce((sum, part) => sum + part.size, 0) !== value.size) {
    throw new RangeError(`Invalid WSD model size: size=${value.size} parts=${parts.length}`);
  }
  if (!value.metadata || typeof value.metadata !== 'object') {
    throw new TypeError('Invalid WSD manifest metadata hashes.');
  }
  const metadata = value.metadata as Record<string, unknown>;
  for (const file of METADATA_FILES) {
    if (typeof metadata[file] !== 'string' || !/^[0-9a-f]{64}$/.test(metadata[file])) {
      throw new TypeError(`Invalid WSD metadata checksum: file=${file}`);
    }
  }
  return { revision: value.revision, size: value.size, parts, metadata: metadata as Record<string, string> };
}

async function loadManifest(cache: Cache): Promise<ModelManifest> {
  const url = `${MODEL_BASE}manifest.json`;
  let bytes: ArrayBuffer;
  try {
    bytes = await fetchBytes(url, MANIFEST_TIMEOUT_MS);
  } catch (error) {
    const cached = await cache.match(url);
    if (!cached) {
      throw error;
    }
    console.warn('wsd-using-cached-manifest', { url, error });
    try {
      return parseManifest(await cached.json() as unknown);
    } catch (cacheError) {
      await cache.delete(url);
      throw new Error(`WSD manifest unavailable and cached copy is invalid: url=${url} network=${errorMessage(error)} cache=${errorMessage(cacheError)}`);
    }
  }
  const manifest = parseManifest(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  await cache.put(url, new Response(bytes));
  return manifest;
}

async function validatedCachedBytes(cache: Cache, url: string, expectedHash: string): Promise<ArrayBuffer | null> {
  const cached = await cache.match(url);
  if (!cached) {
    return null;
  }
  const bytes = await cached.arrayBuffer();
  if (await sha256(bytes) === expectedHash) {
    return bytes;
  }
  console.warn('wsd-invalid-cached-asset', { url, expectedHash });
  await cache.delete(url);
  return null;
}

async function migrateLegacyBytes(cache: Cache, url: string, expectedHash: string): Promise<ArrayBuffer | null> {
  const legacyUrl = url.split('?')[0];
  const bytes = await validatedCachedBytes(cache, legacyUrl, expectedHash);
  if (!bytes) {
    return null;
  }
  await cache.delete(legacyUrl);
  await cache.put(url, new Response(bytes));
  return bytes;
}

async function downloadMetadata(cache: Cache, name: string, expectedHash: string): Promise<unknown> {
  const url = `${MODEL_BASE}${name}?sha256=${expectedHash}`;
  const cached = await validatedCachedBytes(cache, url, expectedHash)
    ?? await migrateLegacyBytes(cache, url, expectedHash);
  const bytes = cached ?? await fetchVerifiedBytes(url, expectedHash, METADATA_TIMEOUT_MS);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new SyntaxError(`Invalid WSD metadata JSON: url=${url} error=${errorMessage(error)}`);
  }
  if (!cached) {
    await cache.put(url, new Response(bytes));
  }
  return value;
}

async function downloadPartOnce(part: ModelPart, onProgress: (bytes: number) => void): Promise<ArrayBuffer> {
  const url = `${MODEL_BASE}${part.name}?sha256=${part.sha256}`;
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`WSD download failed: url=${url} status=${response.status} statusText=${response.statusText} body=${(await response.text()).slice(0, 500)}`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error(`WSD model response has no readable body: url=${url}`);
    }
    const bytes = new Uint8Array(part.size);
    let offset = 0;
    let reportedOffset = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
      if (offset + result.value.length > part.size) {
        throw new RangeError(`WSD model part exceeds declared size: url=${url} expected=${part.size}`);
      }
      bytes.set(result.value, offset);
      offset += result.value.length;
      if (offset - reportedOffset >= 1_000_000 || offset === part.size) {
        onProgress(offset);
        reportedOffset = offset;
      }
    }
    if (offset !== part.size) {
      throw new RangeError(`Incomplete WSD model part: url=${url} expected=${part.size} actual=${offset}`);
    }
    const actualHash = await sha256(bytes.buffer);
    if (actualHash !== part.sha256) {
      throw new Error(`WSD model part checksum mismatch: url=${url} expected=${part.sha256} actual=${actualHash}`);
    }
    return bytes.buffer;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadPart(cache: Cache, part: ModelPart, onProgress: (bytes: number) => void): Promise<ArrayBuffer> {
  const url = `${MODEL_BASE}${part.name}?sha256=${part.sha256}`;
  const cached = await validatedCachedBytes(cache, url, part.sha256)
    ?? await migrateLegacyBytes(cache, url, part.sha256);
  if (cached) {
    if (cached.byteLength !== part.size) {
      await cache.delete(url);
    } else {
      onProgress(part.size);
      return cached;
    }
  }
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    onProgress(0);
    let bytes: ArrayBuffer;
    try {
      bytes = await downloadPartOnce(part, onProgress);
    } catch (error) {
      lastError = new Error(`WSD model part download failed: url=${url} attempt=${attempt} error=${errorMessage(error)}`);
      console.warn('wsd-download-retry', { url, attempt, error: lastError });
      if (attempt < 3) {
        await pauseBeforeRetry(attempt);
      }
      continue;
    }
    await cache.put(url, new Response(bytes));
    onProgress(part.size);
    return bytes;
  }
  throw lastError ?? new Error(`WSD model part download failed without an error: url=${url}`);
}

async function loadModelParts(cache: Cache, manifest: ModelManifest): Promise<Uint8Array> {
  const modelBytes = new Uint8Array(manifest.size);
  const progress: number[] = manifest.parts.map(() => 0);
  const offsets: number[] = [];
  let offset = 0;
  for (const part of manifest.parts) {
    offsets.push(offset);
    offset += part.size;
  }
  let nextIndex = 0;
  const loadNextPart = async (): Promise<void> => {
    while (nextIndex < manifest.parts.length) {
      const index = nextIndex++;
      const part = manifest.parts[index];
      const bytes = await downloadPart(cache, part, (loadedBytes) => {
        progress[index] = loadedBytes;
        reportStatus('downloading', progress.reduce((sum, value) => sum + value, 0), manifest.size, 'Downloading model');
      });
      modelBytes.set(new Uint8Array(bytes), offsets[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_MODEL_PARTS, manifest.parts.length) }, () => loadNextPart()));
  return modelBytes;
}

async function loadWasmBinary(cache: Cache): Promise<ArrayBuffer> {
  const cached = await cache.match(wasmUrl);
  if (cached) {
    const bytes = await cached.arrayBuffer();
    if (WebAssembly.validate(bytes)) {
      return bytes;
    }
    await cache.delete(wasmUrl);
  }
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let bytes: ArrayBuffer;
    try {
      bytes = await fetchBytesOnce(wasmUrl, WASM_TIMEOUT_MS);
      if (!WebAssembly.validate(bytes)) {
        throw new Error(`Invalid WSD runtime binary: url=${wasmUrl}`);
      }
    } catch (error) {
      lastError = new Error(`WSD runtime download failed: url=${wasmUrl} attempt=${attempt} error=${errorMessage(error)}`);
      console.warn('wsd-download-retry', { url: wasmUrl, attempt, error: lastError });
      if (attempt < 3) {
        await pauseBeforeRetry(attempt);
      }
      continue;
    }
    await cache.put(wasmUrl, new Response(bytes));
    return bytes;
  }
  throw lastError ?? new Error(`WSD runtime download failed without an error: url=${wasmUrl}`);
}

async function discardStaleAssets(cache: Cache, manifest: ModelManifest): Promise<void> {
  const current = new Set<string>([
    `${MODEL_BASE}manifest.json`,
    wasmUrl,
    ...manifest.parts.map((part) => `${MODEL_BASE}${part.name}?sha256=${part.sha256}`),
    ...METADATA_FILES.map((file) => `${MODEL_BASE}${file}?sha256=${manifest.metadata[file]}`),
  ]);
  for (const request of await cache.keys()) {
    if (!current.has(request.url) && !current.has(new URL(request.url).pathname + new URL(request.url).search)) {
      await cache.delete(request);
    }
  }
}

async function loadModel(): Promise<void> {
  reportStatus('loading', 0, 0, 'Checking model files');
  const cache = await caches.open(CACHE_NAME);
  const manifest = await loadManifest(cache);
  reportStatus('downloading', 0, manifest.size, 'Downloading model');
  const [modelBytes, tokenizerJson, tokenizerConfig, answerLetters, wasmBinary] = await Promise.all([
    loadModelParts(cache, manifest),
    downloadMetadata(cache, 'tokenizer.json', manifest.metadata['tokenizer.json']),
    downloadMetadata(cache, 'tokenizer_config.json', manifest.metadata['tokenizer_config.json']),
    downloadMetadata(cache, 'answer_letters.json', manifest.metadata['answer_letters.json']),
    loadWasmBinary(cache),
  ]);
  reportStatus('loading', manifest.size, manifest.size, 'Preparing model');
  if (!answerLetters || typeof answerLetters !== 'object'
    || !Array.isArray((answerLetters as Record<string, unknown>).letters)
    || (answerLetters as { letters: unknown[] }).letters.length !== 128
    || !(answerLetters as { letters: unknown[] }).letters.every((letter) => typeof letter === 'string')) {
    throw new TypeError('Invalid WSD answer letters.');
  }
  const loadedTokenizer = new Tokenizer(tokenizerJson as object, tokenizerConfig as object);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmBinary = wasmBinary;
  const loadedSession = await ort.InferenceSession.create(modelBytes.buffer, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  tokenizer = loadedTokenizer;
  letters = (answerLetters as { letters: string[] }).letters;
  session = loadedSession;
  await discardStaleAssets(cache, manifest);
  reportStatus('ready', manifest.size, manifest.size, 'Ready');
}

function prepare(): Promise<void> {
  if (!preparePromise) {
    preparePromise = loadModel().catch((error: unknown) => {
      preparationFailed = true;
      reportStatus('error', 0, 0, errorMessage(error));
      throw error;
    });
  }
  return preparePromise;
}

function retryPreparation(): void {
  if (preparationFailed) {
    preparePromise = null;
    preparationFailed = false;
  }
  void prepare().catch((error: unknown) => {
    console.error('wsd-model-preparation-failed', { error });
  });
}

async function score(request: ScoreRequest): Promise<void> {
  await prepare();
  if (!session || !tokenizer || !letters) {
    throw new Error('WSD model is not initialized after preparation.');
  }
  const prompt = buildWsdPrompt(request.context, request.glosses, letters);
  const ids = tokenizer.encode(prompt, { add_special_tokens: true }).ids;
  if (ids.length > MAX_TOKENS) {
    throw new RangeError(`WSD prompt exceeds model context: tokens=${ids.length} maximum=${MAX_TOKENS}`);
  }
  const maskId = tokenizer.token_to_id('[MASK]');
  const positions = ids.flatMap((id, index) => id === maskId ? [index] : []);
  if (positions.length !== 1) {
    throw new Error(`WSD prompt must contain exactly one mask: count=${positions.length}`);
  }
  const output = await session.run({
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, (id) => BigInt(id)), [1, ids.length]),
    attention_mask: new ort.Tensor('int64', BigInt64Array.from(ids, () => 1n), [1, ids.length]),
    prediction_positions: new ort.Tensor('int64', BigInt64Array.of(BigInt(positions[0])), [1]),
  });
  if (canceled.has(request.id)) {
    return;
  }
  const logits = output.logits;
  if (!logits || logits.dims[0] !== 1 || logits.dims[1] !== 128) {
    throw new Error(`Unexpected WSD model output: dims=${JSON.stringify(logits?.dims)}`);
  }
  self.postMessage({ type: 'scores', id: request.id, scores: Array.from(logits.data, Number).slice(0, request.glosses.length) });
}

async function processQueue(): Promise<void> {
  if (processing) {
    return;
  }
  processing = true;
  try {
    while (popupQueue.length > 0 || cardQueue.length > 0) {
      const request = popupQueue.shift() ?? cardQueue.shift();
      if (!request) {
        throw new Error('WSD request queue was empty while processing.');
      }
      activeId = request.id;
      try {
        await score(request);
      } catch (error) {
        if (!canceled.has(request.id)) {
          console.error('wsd-inference-failed', { id: request.id, error });
          self.postMessage({ type: 'error', id: request.id, message: errorMessage(error) });
        }
      } finally {
        if (canceled.has(request.id)) {
          self.postMessage({ type: 'canceled', id: request.id });
        }
        canceled.delete(request.id);
        activeId = null;
      }
    }
  } finally {
    processing = false;
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const request = event.data;
  if (request.type === 'prepare') {
    retryPreparation();
  } else if (request.type === 'cancel') {
    const popupIndex = popupQueue.findIndex((queued) => queued.id === request.id);
    const cardIndex = cardQueue.findIndex((queued) => queued.id === request.id);
    if (popupIndex >= 0) {
      popupQueue.splice(popupIndex, 1);
      self.postMessage({ type: 'canceled', id: request.id });
    } else if (cardIndex >= 0) {
      cardQueue.splice(cardIndex, 1);
      self.postMessage({ type: 'canceled', id: request.id });
    } else if (activeId === request.id) {
      canceled.add(request.id);
    }
  } else {
    (request.priority === 'popup' ? popupQueue : cardQueue).push(request);
    void processQueue();
  }
};
