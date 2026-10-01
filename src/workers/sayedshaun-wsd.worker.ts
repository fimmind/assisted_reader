import { Tokenizer } from '@huggingface/tokenizers';
import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import type { WsdContext } from '../core/wsd-filter';

interface ModelPart {
  name: string;
  size: number;
  sha256: string;
}

interface VectorPart { count: number; metadataSha256: string; vectorsSha256: string; bytes: number }
type BucketIndex = Record<string, [number, string[]]>;
interface VectorBucket { index: BucketIndex; data: DataView; count: number }

interface ModelManifest {
  revision: string;
  size: number;
  parts: ModelPart[];
  metadata: Record<string, string>;
  vectors: { format: string; dimensions: number; count: number; buckets: Record<string, VectorPart> };
}

interface ScoreRequest {
  type: 'score';
  id: number;
  context: WsdContext;
  glosses: string[];
  word: string;
  senseIds: string[];
}

type WorkerRequest = { type: 'prepare' } | { type: 'cancel'; id: number } | ScoreRequest;

const MODEL_BASE = `${import.meta.env.BASE_URL}wsd/sayedshaun-wsd/`;
const CACHE_NAME = 'easeword-sayedshaun-wsd-54e41c09-int8-v1';
const MODEL_REVISION = '54e41c09c61ae8bd60c62e40bf483141c49ce0d3';
const MAX_TOKENS = 256;
const VECTOR_SIZE = 768;
const MAX_MEMORY_BUCKETS = 16;
const REQUEST_TIMEOUT_MS = 120_000;

let session: ort.InferenceSession | null = null;
let tokenizer: Tokenizer | null = null;
let preparePromise: Promise<void> | null = null;
const canceled = new Set<number>();
let manifest: ModelManifest | null = null;
const bucketCache = new Map<string, Promise<VectorBucket>>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportStatus(phase: 'downloading' | 'loading' | 'ready' | 'error', downloadedBytes: number, totalBytes: number, message: string): void {
  self.postMessage({ type: 'status', phase, downloadedBytes, totalBytes, message });
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function verifiedBytes(cache: Cache, url: string, expectedHash: string): Promise<ArrayBuffer> {
  const cached = await cache.match(url);
  if (cached) {
    const bytes = await cached.arrayBuffer();
    if (await sha256(bytes) === expectedHash) {
      return bytes;
    }
    await cache.delete(url);
  }
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) {
        throw new Error(`status=${response.status} body=${(await response.text()).slice(0, 500)}`);
      }
      const bytes = await response.arrayBuffer();
      const actual = await sha256(bytes);
      if (actual !== expectedHash) {
        throw new Error(`checksum mismatch: expected=${expectedHash} actual=${actual}`);
      }
      await cache.put(url, new Response(bytes));
      return bytes;
    } catch (error) {
      lastError = new Error(`WSD asset download failed: url=${url} attempt=${attempt} error=${errorMessage(error)}`);
      console.warn('wsd-download-retry', { url, attempt, error: lastError });
    }
  }
  throw lastError ?? new Error(`WSD asset download failed without an error: url=${url}`);
}

async function loadManifest(): Promise<ModelManifest> {
  const url = `${MODEL_BASE}manifest.json`;
  let manifest: ModelManifest | null = null;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) {
        throw new Error(`status=${response.status} body=${(await response.text()).slice(0, 500)}`);
      }
      manifest = await response.json() as ModelManifest;
      break;
    } catch (error) {
      lastError = new Error(`WSD manifest download failed: url=${url} attempt=${attempt} error=${errorMessage(error)}`);
      console.warn('wsd-download-retry', { url, attempt, error: lastError });
    }
  }
  if (!manifest) {
    throw lastError ?? new Error(`WSD manifest download failed without an error: url=${url}`);
  }
  if (manifest.revision !== MODEL_REVISION || !Number.isSafeInteger(manifest.size)
    || manifest.size <= 0 || manifest.size > 100_000_000
    || !Array.isArray(manifest.parts) || manifest.parts.length < 1 || manifest.parts.length > 4
    || manifest.parts.reduce((sum, part, index) => {
      if (part.name !== `model.part${String(index).padStart(2, '0')}` || !Number.isSafeInteger(part.size)
        || part.size <= 0 || !/^[0-9a-f]{64}$/.test(part.sha256)) {
        throw new TypeError(`Invalid SayedShaun WSD part: index=${index}`);
      }
      return sum + part.size;
    }, 0) !== manifest.size
    || !/^[0-9a-f]{64}$/.test(manifest.metadata?.['tokenizer.json'] ?? '')
    || !/^[0-9a-f]{64}$/.test(manifest.metadata?.['tokenizer_config.json'] ?? '')
    || manifest.vectors?.format !== 'float16-le' || manifest.vectors.dimensions !== VECTOR_SIZE
    || !Number.isSafeInteger(manifest.vectors.count) || Object.keys(manifest.vectors.buckets).length !== 1024) {
    throw new TypeError(`Invalid SayedShaun WSD manifest: url=${url}`);
  }
  return manifest;
}

async function loadWasm(cache: Cache): Promise<ArrayBuffer> {
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
    try {
      const response = await fetch(wasmUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) {
        throw new Error(`status=${response.status} body=${(await response.text()).slice(0, 500)}`);
      }
      const bytes = await response.arrayBuffer();
      if (!WebAssembly.validate(bytes)) {
        throw new Error('invalid WebAssembly binary');
      }
      await cache.put(wasmUrl, new Response(bytes));
      return bytes;
    } catch (error) {
      lastError = new Error(`WSD runtime download failed: url=${wasmUrl} attempt=${attempt} error=${errorMessage(error)}`);
      console.warn('wsd-download-retry', { url: wasmUrl, attempt, error: lastError });
    }
  }
  throw lastError ?? new Error(`WSD runtime download failed without an error: url=${wasmUrl}`);
}

async function loadModel(): Promise<void> {
  reportStatus('loading', 0, 0, 'Checking model files');
  const cache = await caches.open(CACHE_NAME);
  const loadedManifest = await loadManifest();
  let completed = 0;
  const [parts, tokenizerBytes, configBytes, wasmBinary] = await Promise.all([
    Promise.all(loadedManifest.parts.map(async (part) => {
      const bytes = await verifiedBytes(cache, `${MODEL_BASE}${part.name}?sha256=${part.sha256}`, part.sha256);
      if (bytes.byteLength !== part.size) {
        throw new RangeError(`Wrong SayedShaun WSD part size: name=${part.name} expected=${part.size} actual=${bytes.byteLength}`);
      }
      completed += part.size;
      reportStatus('downloading', completed, loadedManifest.size, 'Downloading model');
      return bytes;
    })),
    verifiedBytes(cache, `${MODEL_BASE}tokenizer.json?sha256=${loadedManifest.metadata['tokenizer.json']}`, loadedManifest.metadata['tokenizer.json']),
    verifiedBytes(cache, `${MODEL_BASE}tokenizer_config.json?sha256=${loadedManifest.metadata['tokenizer_config.json']}`, loadedManifest.metadata['tokenizer_config.json']),
    loadWasm(cache),
  ]);
  const modelBytes = new Uint8Array(loadedManifest.size);
  let offset = 0;
  for (const part of parts) {
    modelBytes.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }
  reportStatus('loading', loadedManifest.size, loadedManifest.size, 'Preparing model');
  const loadedTokenizer = new Tokenizer(
    JSON.parse(new TextDecoder().decode(tokenizerBytes)) as object,
    JSON.parse(new TextDecoder().decode(configBytes)) as object,
  );
  if (loadedTokenizer.token_to_id('<classify>') !== 30522 || loadedTokenizer.token_to_id('</classify>') !== 30523) {
    throw new Error('SayedShaun WSD tokenizer has incorrect target marker IDs');
  }
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmBinary = wasmBinary;
  const loadedSession = await ort.InferenceSession.create(modelBytes.buffer, {
    executionProviders: ['wasm'], graphOptimizationLevel: 'all',
  });
  tokenizer = loadedTokenizer;
  session = loadedSession;
  manifest = loadedManifest;
  reportStatus('ready', loadedManifest.size, loadedManifest.size, 'Ready');
}

function prepare(): Promise<void> {
  if (!preparePromise) {
    preparePromise = loadModel().catch((error: unknown) => {
      reportStatus('error', 0, 0, errorMessage(error));
      throw error;
    });
  }
  return preparePromise;
}

function bucketName(word: string): string {
  let hash = 2166136261;
  for (let index = 0; index < word.length; index += 1) {
    hash ^= word.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return String(hash % 1024).padStart(4, '0');
}

async function loadBucket(name: string): Promise<VectorBucket> {
  if (!manifest) throw new Error('SayedShaun manifest is not loaded');
  const part = manifest.vectors.buckets[name];
  if (!part || part.bytes !== part.count * VECTOR_SIZE * 2
    || !/^[0-9a-f]{64}$/.test(part.metadataSha256) || !/^[0-9a-f]{64}$/.test(part.vectorsSha256)) {
    throw new TypeError(`Invalid SayedShaun vector bucket: name=${name}`);
  }
  const cache = await caches.open(CACHE_NAME);
  const [metadata, bytes] = await Promise.all([
    verifiedBytes(cache, `${MODEL_BASE}vectors/${name}.json?sha256=${part.metadataSha256}`, part.metadataSha256),
    verifiedBytes(cache, `${MODEL_BASE}vectors/${name}.bin?sha256=${part.vectorsSha256}`, part.vectorsSha256),
  ]);
  if (bytes.byteLength !== part.bytes) {
    throw new RangeError(`SayedShaun vector bucket size mismatch: name=${name} expected=${part.bytes} actual=${bytes.byteLength}`);
  }
  return { index: JSON.parse(new TextDecoder().decode(metadata)) as BucketIndex, data: new DataView(bytes), count: part.count };
}

function getBucket(name: string): Promise<VectorBucket> {
  const cached = bucketCache.get(name);
  if (cached) {
    bucketCache.delete(name);
    bucketCache.set(name, cached);
    return cached;
  }
  const pending = loadBucket(name).catch((error: unknown) => {
    bucketCache.delete(name);
    throw error;
  });
  bucketCache.set(name, pending);
  if (bucketCache.size > MAX_MEMORY_BUCKETS) {
    const oldest = bucketCache.keys().next().value;
    if (oldest !== undefined) bucketCache.delete(oldest);
  }
  return pending;
}

function float16(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) throw new RangeError(`Invalid SayedShaun vector value: bits=${bits}`);
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function dot(bucket: VectorBucket, index: number, context: Float32Array): number {
  if (!Number.isInteger(index) || index < 0 || index >= bucket.count) {
    throw new RangeError(`Invalid SayedShaun vector index: index=${index} count=${bucket.count}`);
  }
  let sum = 0;
  for (let dimension = 0; dimension < VECTOR_SIZE; dimension += 1) {
    sum += float16(bucket.data.getUint16((index * VECTOR_SIZE + dimension) * 2, true)) * context[dimension];
  }
  return sum;
}


function tokenIds(text: string): number[] {
  if (!tokenizer) {
    throw new Error('SayedShaun WSD tokenizer is not loaded');
  }
  const ids = tokenizer.encode(text, { add_special_tokens: true }).ids;
  return ids.length <= MAX_TOKENS ? ids : [...ids.slice(0, MAX_TOKENS - 1), 102];
}

async function encodeTexts(texts: string[]): Promise<Float32Array[]> {
  if (!session) {
    throw new Error('SayedShaun WSD model is not loaded');
  }
  const ids = texts.map(tokenIds);
  const length = Math.max(...ids.map((tokens) => tokens.length));
  const inputIds = new BigInt64Array(ids.length * length);
  const attentionMask = new BigInt64Array(ids.length * length);
  ids.forEach((tokens, row) => tokens.forEach((token, column) => {
    inputIds[row * length + column] = BigInt(token);
    attentionMask[row * length + column] = 1n;
  }));
  const output = await session.run({
    input_ids: new ort.Tensor('int64', inputIds, [ids.length, length]),
    attention_mask: new ort.Tensor('int64', attentionMask, [ids.length, length]),
  });
  const embedding = output.embedding;
  if (!embedding || embedding.dims[0] !== ids.length || embedding.dims[1] !== VECTOR_SIZE) {
    throw new Error(`Unexpected SayedShaun WSD embedding: dims=${JSON.stringify(embedding?.dims)}`);
  }
  const data = embedding.data as Float32Array;
  return ids.map((_, row) => data.slice(row * VECTOR_SIZE, (row + 1) * VECTOR_SIZE));
}

function markedContext(context: WsdContext): string {
  if (context.start < 0 || context.end <= context.start || context.end > context.text.length) {
    throw new RangeError(`Invalid SayedShaun WSD target: start=${context.start} end=${context.end} length=${context.text.length}`);
  }
  return `${context.text.slice(0, context.start)}<classify>${context.text.slice(context.start, context.end)}</classify>${context.text.slice(context.end)}`;
}

async function score(request: ScoreRequest): Promise<number[]> {
  if (request.glosses.length < 2 || request.glosses.length !== request.senseIds.length) {
    throw new RangeError(`Invalid SayedShaun candidate count: glosses=${request.glosses.length} ids=${request.senseIds.length}`);
  }
  await prepare();
  const bucket = await getBucket(bucketName(request.word));
  const item = bucket.index[request.word];
  if (!item) throw new Error(`SayedShaun vectors are missing for WordNet word: word=${request.word}`);
  const [first, ids] = item;
  const context = (await encodeTexts([markedContext(request.context)]))[0];
  return request.senseIds.map((id) => {
    const position = ids.indexOf(id);
    if (position < 0) throw new Error(`SayedShaun vector is missing for WordNet sense: word=${request.word} id=${id}`);
    return dot(bucket, first + position, context);
  });
}

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const request = event.data;
  if (request.type === 'cancel') {
    canceled.add(request.id);
    return;
  }
  if (request.type === 'prepare') {
    void prepare().catch((error: unknown) => console.error('wsd-model-preparation-failed', { error }));
    return;
  }
  void score(request).then((scores) => {
    if (!canceled.has(request.id)) {
      self.postMessage({ type: 'scores', id: request.id, scores });
    } else {
      self.postMessage({ type: 'canceled', id: request.id });
      canceled.delete(request.id);
    }
  }).catch((error: unknown) => {
    if (!canceled.has(request.id)) {
      self.postMessage({ type: 'error', id: request.id, message: errorMessage(error) });
    } else {
      self.postMessage({ type: 'canceled', id: request.id });
      canceled.delete(request.id);
    }
  });
};
