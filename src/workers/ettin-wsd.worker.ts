import { Tokenizer } from '@huggingface/tokenizers';
import * as ort from 'onnxruntime-web/wasm';
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
}

interface ScoreRequest {
  type: 'score';
  id: number;
  context: WsdContext;
  glosses: string[];
}

type WorkerRequest = { type: 'prepare' } | ScoreRequest;
type ModelPhase = 'downloading' | 'loading' | 'ready' | 'error';

const MODEL_BASE = `${import.meta.env.BASE_URL}wsd/ettin-150m-wsd/`;
const CACHE_NAME = 'easeword-ettin-150m-wsd-8751b577-uint8-v1';
const MODEL_REVISION = '8751b577199d1bb95b74fa2457da7065d57100ae';
const MAX_TOKENS = 7999;

let session: ort.InferenceSession | null = null;
let tokenizer: Tokenizer | null = null;
let letters: string[] | null = null;
let preparePromise: Promise<void> | null = null;
let inferenceQueue: Promise<void> = Promise.resolve();

function reportStatus(phase: ModelPhase, downloadedBytes: number, totalBytes: number, message: string): void {
  self.postMessage({ type: 'status', phase, downloadedBytes, totalBytes, message });
}

async function fetchWithRetries(url: string): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`WSD download failed: url=${url} status=${response.status} statusText=${response.statusText} body=${body.slice(0, 500)}`);
      }
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn('wsd-download-retry', { url, attempt, error: lastError });
    }
  }
  throw lastError ?? new Error(`WSD download failed without an error: url=${url}`);
}

async function fetchJson(cache: Cache, url: string): Promise<unknown> {
  const cached = await cache.match(url);
  if (cached) {
    try {
      return await cached.json() as unknown;
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      console.warn('wsd-invalid-cached-json', { url, error });
      await cache.delete(url);
    }
  }
  const response = await fetchWithRetries(url);
  const body = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch (error) {
    throw new SyntaxError(`Invalid WSD JSON: url=${url} status=${response.status} body=${body.slice(0, 500)} error=${String(error)}`);
  }
  await cache.put(url, new Response(body));
  return value;
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
    || value.size <= 0 || value.size > 300_000_000 || value.parts.length > 20) {
    throw new RangeError(`Unsupported WSD manifest: revision=${value.revision} size=${value.size} parts=${value.parts.length}`);
  }
  const parts: ModelPart[] = value.parts.map((item: unknown) => {
    if (!item || typeof item !== 'object') {
      throw new TypeError('Invalid WSD model part.');
    }
    const part = item as Record<string, unknown>;
    if (typeof part.name !== 'string' || !/^model\.part\d{2}$/.test(part.name)
      || typeof part.size !== 'number' || !Number.isSafeInteger(part.size) || part.size <= 0
      || typeof part.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(part.sha256)) {
      throw new TypeError(`Invalid WSD model part: name=${String(part.name)} size=${String(part.size)}`);
    }
    return { name: part.name, size: part.size, sha256: part.sha256 };
  });
  if (parts.length === 0 || parts.reduce((sum, part) => sum + part.size, 0) !== value.size) {
    throw new RangeError(`Invalid WSD model size: size=${value.size} parts=${parts.length}`);
  }
  return { revision: value.revision, size: value.size, parts };
}

async function validatePart(bytes: ArrayBuffer, part: ModelPart): Promise<void> {
  if (bytes.byteLength !== part.size) {
    throw new RangeError(`Incomplete WSD model part: name=${part.name} expected=${part.size} actual=${bytes.byteLength}`);
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== part.sha256) {
    throw new Error(`WSD model part checksum mismatch: name=${part.name} expected=${part.sha256} actual=${actual}`);
  }
}

async function downloadPart(
  cache: Cache,
  part: ModelPart,
  downloadedBytes: number,
  totalBytes: number,
): Promise<ArrayBuffer> {
  const url = `${MODEL_BASE}${part.name}`;
  const cached = await cache.match(url);
  if (cached) {
    const bytes = await cached.arrayBuffer();
    try {
      await validatePart(bytes, part);
      reportStatus('downloading', downloadedBytes + part.size, totalBytes, 'Using downloaded model');
      return bytes;
    } catch (error) {
      console.warn('wsd-invalid-cached-part', { url, error });
      await cache.delete(url);
    }
  }
  const response = await fetchWithRetries(url);
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
    if (offset + result.value.length > part.size) {
      throw new RangeError(`WSD model part exceeds declared size: name=${part.name} expected=${part.size}`);
    }
    bytes.set(result.value, offset);
    offset += result.value.length;
    if (offset - reportedOffset >= 1_000_000 || offset === part.size) {
      reportStatus('downloading', downloadedBytes + offset, totalBytes, 'Downloading model');
      reportedOffset = offset;
    }
  }
  await validatePart(bytes.buffer, part);
  await cache.put(url, new Response(bytes));
  return bytes.buffer;
}

async function loadModel(): Promise<void> {
  reportStatus('loading', 0, 0, 'Checking model files');
  const cache = await caches.open(CACHE_NAME);
  const manifest = parseManifest(await fetchJson(cache, `${MODEL_BASE}manifest.json`));
  const modelBytes = new Uint8Array(manifest.size);
  let downloadedBytes = 0;
  reportStatus('downloading', 0, manifest.size, 'Downloading model');
  for (const part of manifest.parts) {
    const bytes = await downloadPart(cache, part, downloadedBytes, manifest.size);
    modelBytes.set(new Uint8Array(bytes), downloadedBytes);
    downloadedBytes += part.size;
  }
  reportStatus('loading', manifest.size, manifest.size, 'Preparing model');
  const [tokenizerJson, tokenizerConfig, answerLetters] = await Promise.all([
    fetchJson(cache, `${MODEL_BASE}tokenizer.json`),
    fetchJson(cache, `${MODEL_BASE}tokenizer_config.json`),
    fetchJson(cache, `${MODEL_BASE}answer_letters.json`),
  ]);
  if (!answerLetters || typeof answerLetters !== 'object'
    || !Array.isArray((answerLetters as Record<string, unknown>).letters)
    || (answerLetters as { letters: unknown[] }).letters.length !== 128
    || !(answerLetters as { letters: unknown[] }).letters.every((letter) => typeof letter === 'string')) {
    throw new TypeError('Invalid WSD answer letters.');
  }
  const loadedTokenizer = new Tokenizer(tokenizerJson as object, tokenizerConfig as object);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = { wasm: `${import.meta.env.BASE_URL}wsd/onnxruntime/ort-wasm-simd-threaded.wasm` };
  const loadedSession = await ort.InferenceSession.create(modelBytes.buffer, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  tokenizer = loadedTokenizer;
  letters = (answerLetters as { letters: string[] }).letters;
  session = loadedSession;
  reportStatus('ready', manifest.size, manifest.size, 'Ready');
}

function prepare(): Promise<void> {
  if (!preparePromise) {
    preparePromise = loadModel().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      reportStatus('error', 0, 0, message);
      preparePromise = null;
      throw error;
    });
  }
  return preparePromise;
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
  const logits = output.logits;
  if (!logits || logits.dims[0] !== 1 || logits.dims[1] !== 128) {
    throw new Error(`Unexpected WSD model output: dims=${JSON.stringify(logits?.dims)}`);
  }
  const scores = Array.from(logits.data, Number).slice(0, request.glosses.length);
  self.postMessage({ type: 'scores', id: request.id, scores });
}

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  if (event.data.type === 'prepare') {
    void prepare().catch((error: unknown) => {
      console.error('wsd-model-preparation-failed', { error });
    });
    return;
  }
  const request = event.data;
  inferenceQueue = inferenceQueue.then(() => score(request)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('wsd-inference-failed', { id: request.id, error });
    self.postMessage({ type: 'error', id: request.id, message });
  });
};
