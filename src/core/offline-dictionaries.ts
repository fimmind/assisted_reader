export type OfflineDictionaryPhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'error' | 'deleting';

export interface OfflineDictionaryStatus {
  enabled: boolean;
  phase: OfflineDictionaryPhase;
  downloadedBytes: number;
  totalBytes: number;
  message: string | null;
}

interface DictionaryFile {
  path: string;
  asset: string;
  compressedBytes: number;
  uncompressedBytes: number;
  sha256: string;
}

interface DictionaryManifest {
  schemaVersion: 1;
  version: string;
  totalBytes: number;
  files: DictionaryFile[];
}

interface StoredState {
  enabled: boolean;
  ready: boolean;
  manifest: DictionaryManifest | null;
}

interface StoredFile {
  path: string;
  sha256: string;
  bytes: ArrayBuffer;
}

const DATABASE_NAME = 'easeword-offline-dictionaries';
const STATE_KEY = 'state';
const MANIFEST_PATH = 'data/offline-dictionaries/manifest.json';
const HEADWORDS_PATH = 'data/lexicon/headwords.json';
const DOWNLOAD_CONCURRENCY = 4;
const FETCH_ATTEMPTS = 3;
const listeners = new Set<(status: OfflineDictionaryStatus) => void>();
let status: OfflineDictionaryStatus = { enabled: false, phase: 'checking', downloadedBytes: 0, totalBytes: 0, message: null };
let initialization: Promise<void> | null = null;
let operation: Promise<void> = Promise.resolve();
let controller: AbortController | null = null;
let revision = 0;
let resourceGeneration = 0;
let requestedEnabled: boolean | null = null;
let installedManifest: DictionaryManifest | null = null;
const channel = typeof window !== 'undefined' && typeof window.BroadcastChannel !== 'undefined'
  ? new window.BroadcastChannel('easeword-offline-dictionaries')
  : null;

channel?.addEventListener('message', (event: MessageEvent<unknown>): void => {
  if (event.data !== 'changing' && event.data !== 'changed') return;
  const externalRevision = ++revision;
  resourceGeneration += 1;
  requestedEnabled = null;
  controller?.abort();
  publish({ ...status, enabled: true, phase: 'checking', message: null });
  if (event.data === 'changed') {
    void (async (): Promise<void> => {
      const state = await readRecord<StoredState>('metadata', STATE_KEY);
      if (externalRevision !== revision) return;
      installedManifest = state?.manifest ? validateManifest(state.manifest) : null;
      const enabled = state?.enabled === true;
      const ready = enabled && state?.ready === true && installedManifest !== null;
      publish({ enabled, phase: ready ? 'ready' : enabled ? 'error' : 'idle', downloadedBytes: ready ? installedManifest?.totalBytes ?? 0 : 0, totalBytes: installedManifest?.totalBytes ?? 0, message: enabled && !ready ? 'Dictionary download was interrupted. Retry to continue.' : null });
    })().catch((error: unknown) => {
      if (externalRevision === revision) publish({ ...status, enabled: true, phase: 'error', message: error instanceof Error ? error.message : String(error) });
    });
  }
});

function publish(next: OfflineDictionaryStatus): void {
  status = next;
  for (const listener of listeners) listener({ ...status });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = (): void => {
      request.result.createObjectStore('metadata');
      request.result.createObjectStore('files', { keyPath: 'path' });
    };
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error ?? new Error('Could not open offline dictionary database.'));
    request.onblocked = (): void => reject(new Error('Offline dictionary database is blocked by another browser tab.'));
  });
}

async function readRecord<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const database = await openDatabase();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).get(key);
      request.onsuccess = (): void => resolve(request.result as T | undefined);
      request.onerror = (): void => reject(request.error ?? new Error(`Could not read offline dictionary record: store=${storeName} key=${String(key)}`));
      transaction.onabort = (): void => reject(transaction.error ?? new Error(`Offline dictionary read aborted: store=${storeName}`));
    });
  } finally {
    database.close();
  }
}

async function writeRecord(storeName: string, value: StoredState | StoredFile, key: string | null): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      if (key === null) store.put(value);
      else store.put(value, key);
      transaction.oncomplete = (): void => resolve();
      transaction.onabort = (): void => reject(transaction.error ?? new Error(`Offline dictionary write aborted: store=${storeName}`));
      transaction.onerror = (): void => reject(transaction.error ?? new Error(`Could not write offline dictionary record: store=${storeName}`));
    });
  } finally {
    database.close();
  }
}

async function clearFiles(): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('files', 'readwrite');
      transaction.objectStore('files').clear();
      transaction.oncomplete = (): void => resolve();
      transaction.onabort = (): void => reject(transaction.error ?? new Error('Offline dictionary deletion aborted.'));
      transaction.onerror = (): void => reject(transaction.error ?? new Error('Could not delete offline dictionary files.'));
    });
  } finally {
    database.close();
  }
}

function validateManifest(candidate: unknown): DictionaryManifest {
  if (!candidate || typeof candidate !== 'object') throw new Error('Invalid offline dictionary manifest: expected an object.');
  const value = candidate as Record<string, unknown>;
  if (value.schemaVersion !== 1 || typeof value.version !== 'string' || value.version.length === 0 || !Array.isArray(value.files)) {
    throw new Error('Invalid offline dictionary manifest header.');
  }
  const paths = new Set<string>();
  const files: DictionaryFile[] = value.files.map((candidateFile: unknown): DictionaryFile => {
    if (!candidateFile || typeof candidateFile !== 'object') throw new Error('Invalid offline dictionary manifest file.');
    const file = candidateFile as Record<string, unknown>;
    if (typeof file.path !== 'string' || !/^data\/[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.includes('..') || paths.has(file.path)
      || typeof file.asset !== 'string' || !/^data\/offline-dictionaries\/[a-zA-Z0-9_./-]+\.bin$/.test(file.asset) || file.asset.includes('..')
      || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)
      || typeof file.compressedBytes !== 'number' || !Number.isSafeInteger(file.compressedBytes) || file.compressedBytes <= 0
      || typeof file.uncompressedBytes !== 'number' || !Number.isSafeInteger(file.uncompressedBytes) || file.uncompressedBytes <= 0) {
      throw new Error(`Invalid offline dictionary manifest file: path=${String(file.path)}`);
    }
    paths.add(file.path);
    return { path: file.path, asset: file.asset, sha256: file.sha256, compressedBytes: file.compressedBytes, uncompressedBytes: file.uncompressedBytes };
  });
  const totalBytes = files.reduce((total, file) => total + file.compressedBytes, 0);
  if (value.totalBytes !== totalBytes || !Number.isSafeInteger(totalBytes)) throw new Error('Invalid offline dictionary manifest total size.');
  for (const required of ['data/lemma_dict.json', 'data/lexicon/inflection-index.json', 'data/lexicon/index.json', 'data/wordnet/index.json']) {
    if (!paths.has(required)) throw new Error(`Offline dictionary manifest is missing a required file: ${required}`);
  }
  for (let index = 0; index < 1024; index += 1) {
    const filename = `${String(index).padStart(4, '0')}.json`;
    for (const directory of ['lexicon', 'wordnet']) {
      const path = `data/${directory}/${filename}`;
      if (!paths.has(path)) throw new Error(`Offline dictionary manifest is missing a required file: ${path}`);
    }
  }
  return { schemaVersion: 1, version: value.version, totalBytes, files };
}

async function hasCompleteDownload(manifest: DictionaryManifest): Promise<boolean> {
  const database = await openDatabase();
  try {
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = database.transaction('files', 'readonly').objectStore('files').getAllKeys();
      request.onsuccess = (): void => resolve(request.result);
      request.onerror = (): void => reject(request.error ?? new Error('Could not inspect downloaded dictionary files.'));
    });
    const paths = new Set(keys);
    return manifest.files.every((file) => paths.has(file.path));
  } finally {
    database.close();
  }
}

async function migrateOfflineHeadwords(manifest: DictionaryManifest, startingRevision: number): Promise<DictionaryManifest> {
  const headwords = new Set<string>();
  for (const file of manifest.files) {
    if (startingRevision !== revision) return manifest;
    const saved = await readRecord<StoredFile>('files', file.path);
    if (!saved || saved.sha256 !== file.sha256 || !(saved.bytes instanceof ArrayBuffer)
      || saved.bytes.byteLength !== file.compressedBytes || await hashBytes(saved.bytes) !== file.sha256) {
      throw new Error(`Cannot update dictionary search index: downloaded file is missing or invalid: path=${file.path}`);
    }
    if (!/^data\/(lexicon|wordnet)\/\d{4}\.json$/.test(file.path)) continue;
    const stream = new Blob([saved.bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const bytes = await new Response(stream).arrayBuffer();
    if (bytes.byteLength !== file.uncompressedBytes) {
      throw new Error(`Cannot update dictionary search index: decompressed size mismatch: path=${file.path}`);
    }
    const entries: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(entries)) throw new TypeError(`Invalid dictionary bucket: path=${file.path}`);
    for (const entry of entries as Array<{ word: string; senses: Array<{ definitions: Array<string | { gloss: string }> }> }>) {
      if (entry.senses.some((sense) => sense.definitions.some((definition) =>
        (typeof definition === 'string' ? definition : definition.gloss).trim().length > 0,
      ))) headwords.add(entry.word);
    }
  }
  const rawBytes = new TextEncoder().encode(JSON.stringify([...headwords].sort()));
  const compressed = new Blob([rawBytes]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = await new Response(compressed).arrayBuffer();
  const sha256 = await hashBytes(bytes);
  const file: DictionaryFile = {
    path: HEADWORDS_PATH,
    asset: 'data/offline-dictionaries/lexicon/headwords.json.bin',
    compressedBytes: bytes.byteLength,
    uncompressedBytes: rawBytes.byteLength,
    sha256,
  };
  const files = [...manifest.files, file];
  const nextManifest: DictionaryManifest = {
    ...manifest,
    version: await hashBytes(new TextEncoder().encode(JSON.stringify(files)).buffer),
    totalBytes: manifest.totalBytes + file.compressedBytes,
    files,
  };
  if (startingRevision !== revision) return manifest;
  await writeRecord('files', { path: HEADWORDS_PATH, sha256, bytes }, null);
  if (startingRevision !== revision) return manifest;
  await writeRecord('metadata', { enabled: true, ready: true, manifest: nextManifest }, STATE_KEY);
  return nextManifest;
}

function initialize(): Promise<void> {
  if (!initialization) {
    const startingRevision = revision;
    initialization = (async (): Promise<void> => {
      if (typeof indexedDB === 'undefined') {
        if (requestedEnabled === true) throw new Error('Offline dictionaries require IndexedDB support in this browser.');
        publish({ enabled: false, phase: 'idle', downloadedBytes: 0, totalBytes: 0, message: null });
        return;
      }
      const state = await readRecord<StoredState>('metadata', STATE_KEY);
      if (startingRevision !== revision && requestedEnabled === null) return;
      if (!state || !state.enabled) {
        if (requestedEnabled === true) publish({ ...status, enabled: true, phase: 'checking' });
        else if (requestedEnabled === false) publish({ ...status, enabled: true, phase: 'deleting' });
        else publish({ enabled: false, phase: 'idle', downloadedBytes: 0, totalBytes: 0, message: null });
        return;
      }
      publish({ ...status, enabled: true });
      installedManifest = state.manifest ? validateManifest(state.manifest) : null;
      let ready = state.ready && installedManifest !== null;
      if (installedManifest && !installedManifest.files.some((file) => file.path === HEADWORDS_PATH)
        && (ready || await hasCompleteDownload(installedManifest))) {
        publish({ ...status, phase: 'checking', message: 'Preparing dictionary search index.' });
        const migratedManifest = await migrateOfflineHeadwords(installedManifest, startingRevision);
        if (startingRevision !== revision) return;
        installedManifest = migratedManifest;
        ready = true;
      }
      publish({ enabled: true, phase: requestedEnabled === false ? 'deleting' : ready ? 'ready' : requestedEnabled === true ? 'checking' : 'error', downloadedBytes: ready ? installedManifest?.totalBytes ?? 0 : 0, totalBytes: installedManifest?.totalBytes ?? 0, message: ready || requestedEnabled !== null ? null : 'Dictionary download was interrupted. Retry to continue.' });
    })().catch((error: unknown) => {
      initialization = null;
      const message = error instanceof Error ? error.message : String(error);
      publish({ ...status, phase: 'error', message });
      throw error;
    });
  }
  return initialization;
}

export async function getOfflineDictionaryStatus(): Promise<OfflineDictionaryStatus> {
  await initialize();
  return { ...status };
}

export function subscribeOfflineDictionaryStatus(listener: (current: OfflineDictionaryStatus) => void): () => void {
  listeners.add(listener);
  listener({ ...status });
  void initialize().catch(() => undefined);
  return (): void => { listeners.delete(listener); };
}

export function getDictionaryResourceGeneration(): number {
  return resourceGeneration;
}

async function fetchWithRetries(url: string, signal: AbortSignal): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`Dictionary request failed: url=${url} status=${response.status} body=${(await response.text()).slice(0, 500)}`);
      return response;
    } catch (error: unknown) {
      if (signal.aborted) throw new DOMException('Dictionary download cancelled.', 'AbortError');
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn('offline-dictionary-fetch-attempt-failed', { url, attempt, maxAttempts: FETCH_ATTEMPTS, error: lastError.message });
    }
  }
  throw lastError ?? new Error(`Dictionary request failed: url=${url}`);
}

async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte: number) => byte.toString(16).padStart(2, '0')).join('');
}

async function installFile(file: DictionaryFile, baseUrl: string, signal: AbortSignal): Promise<void> {
  const saved = await readRecord<StoredFile>('files', file.path);
  if (saved && saved.sha256 === file.sha256 && saved.bytes instanceof ArrayBuffer && saved.bytes.byteLength === file.compressedBytes && await hashBytes(saved.bytes) === file.sha256) return;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const url = `${baseUrl}${file.asset}`;
      const response = await fetch(url, { signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`Dictionary request failed: url=${url} status=${response.status} body=${(await response.text()).slice(0, 500)}`);
      const bytes = await response.arrayBuffer();
      const actualHash = await hashBytes(bytes);
      if (bytes.byteLength !== file.compressedBytes || actualHash !== file.sha256) {
        throw new Error(`Offline dictionary checksum or size mismatch: path=${file.path} url=${url} status=${response.status} contentEncoding=${response.headers.get('content-encoding') ?? 'none'} expectedBytes=${file.compressedBytes} actualBytes=${bytes.byteLength} expectedSha256=${file.sha256} actualSha256=${actualHash}`);
      }
      if (signal.aborted) throw new DOMException('Dictionary download cancelled.', 'AbortError');
      await writeRecord('files', { path: file.path, sha256: file.sha256, bytes }, null);
      return;
    } catch (error: unknown) {
      if (signal.aborted) throw new DOMException('Dictionary download cancelled.', 'AbortError');
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn('offline-dictionary-file-attempt-failed', { path: file.path, url: `${baseUrl}${file.asset}`, attempt, maxAttempts: FETCH_ATTEMPTS, error: lastError.message });
    }
  }
  throw lastError ?? new Error(`Could not install offline dictionary file: path=${file.path}`);
}

function enqueue(task: () => Promise<void>): Promise<void> {
  const result = operation.then(task, task);
  operation = result.catch(() => undefined);
  return result;
}

export function enableOfflineDictionaries(baseUrl: string): Promise<void> {
  const currentRevision = ++revision;
  resourceGeneration += 1;
  requestedEnabled = true;
  channel?.postMessage('changing');
  controller?.abort();
  publish({ ...status, enabled: true, phase: 'checking', message: null });
  return enqueue(async (): Promise<void> => {
    await initialize();
    if (currentRevision !== revision) return;
    if (typeof indexedDB === 'undefined') {
      const error = new Error('Offline dictionaries require IndexedDB support in this browser.');
      publish({ ...status, enabled: true, phase: 'error', message: error.message });
      throw error;
    }
    if (status.enabled && status.phase === 'ready') { channel?.postMessage('changed'); return; }
    const activeController = new AbortController();
    controller = activeController;
    publish({ ...status, enabled: true, phase: 'checking', message: null });
    try {
      await writeRecord('metadata', { enabled: true, ready: false, manifest: installedManifest }, STATE_KEY);
      if (typeof DecompressionStream === 'undefined') throw new Error('Offline dictionaries require gzip decompression support in this browser.');
      if (typeof crypto === 'undefined' || !crypto.subtle) throw new Error('Offline dictionaries require secure-context SHA-256 support in this browser.');
      if (!installedManifest) {
        const response = await fetchWithRetries(`${baseUrl}${MANIFEST_PATH}`, activeController.signal);
        installedManifest = validateManifest(await response.json() as unknown);
        await writeRecord('metadata', { enabled: true, ready: false, manifest: installedManifest }, STATE_KEY);
      }
      let manifest = installedManifest;
      let downloadedBytes = 0;
      let nextFile = 0;
      publish({ enabled: true, phase: 'downloading', downloadedBytes, totalBytes: manifest.totalBytes, message: null });
      const worker = async (): Promise<void> => {
        while (!activeController.signal.aborted) {
          const index = nextFile++;
          const file = manifest.files[index];
          if (!file) return;
          await installFile(file, baseUrl, activeController.signal);
          downloadedBytes += file.compressedBytes;
          if (currentRevision === revision) publish({ enabled: true, phase: 'downloading', downloadedBytes, totalBytes: manifest.totalBytes, message: null });
        }
      };
      const results = await Promise.allSettled(Array.from({ length: DOWNLOAD_CONCURRENCY }, () => worker().catch((error: unknown) => { activeController.abort(); throw error; })));
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected' && !(result.reason instanceof DOMException && result.reason.name === 'AbortError'));
      if (failed) throw failed.reason;
      if (activeController.signal.aborted || currentRevision !== revision) return;
      if (!manifest.files.some((file) => file.path === HEADWORDS_PATH)) {
        manifest = await migrateOfflineHeadwords(manifest, currentRevision);
        if (currentRevision !== revision) return;
        installedManifest = manifest;
      }
      await writeRecord('metadata', { enabled: true, ready: true, manifest }, STATE_KEY);
      if (currentRevision === revision) {
        publish({ enabled: true, phase: 'ready', downloadedBytes: manifest.totalBytes, totalBytes: manifest.totalBytes, message: null });
        channel?.postMessage('changed');
      }
    } catch (error: unknown) {
      if (currentRevision !== revision) return;
      const message = error instanceof Error ? error.message : String(error);
      publish({ ...status, enabled: true, phase: 'error', message });
      channel?.postMessage('changed');
      throw error;
    } finally {
      if (controller === activeController) controller = null;
    }
  });
}

export function disableOfflineDictionaries(): Promise<void> {
  const currentRevision = ++revision;
  resourceGeneration += 1;
  requestedEnabled = false;
  channel?.postMessage('changing');
  controller?.abort();
  publish({ ...status, enabled: true, phase: 'deleting', message: null });
  return enqueue(async (): Promise<void> => {
    await initialize().catch(() => undefined);
    if (typeof indexedDB === 'undefined') {
      initialization = Promise.resolve();
      if (currentRevision === revision) publish({ enabled: false, phase: 'idle', downloadedBytes: 0, totalBytes: 0, message: null });
      return;
    }
    publish({ ...status, phase: 'deleting', message: null });
    try {
      await clearFiles();
      await writeRecord('metadata', { enabled: false, ready: false, manifest: null }, STATE_KEY);
      installedManifest = null;
      initialization = Promise.resolve();
      if (currentRevision === revision) {
        publish({ enabled: false, phase: 'idle', downloadedBytes: 0, totalBytes: 0, message: null });
        channel?.postMessage('changed');
      }
    } catch (error: unknown) {
      if (currentRevision === revision) {
        publish({ ...status, phase: 'error', message: error instanceof Error ? error.message : String(error) });
        channel?.postMessage('changed');
      }
      throw error;
    }
  });
}

export async function readDictionaryResource(relativePath: string, baseUrl: string): Promise<unknown> {
  await initialize();
  if (!status.enabled) {
    const response = await fetch(`${baseUrl}${relativePath}`);
    const body = await response.text();
    if (!response.ok) throw new Error(`Dictionary request failed: url=${baseUrl}${relativePath} status=${response.status} body=${body.slice(0, 500)}`);
    try { return JSON.parse(body) as unknown; }
    catch (error: unknown) { throw new SyntaxError(`Invalid dictionary JSON: url=${baseUrl}${relativePath} status=${response.status} body=${body.slice(0, 500)}`, { cause: error }); }
  }
  if (status.phase !== 'ready' || !installedManifest) throw new Error(`Offline dictionaries are not ready: phase=${status.phase} message=${status.message ?? ''}`);
  const readRevision = revision;
  try {
    const file = installedManifest.files.find((entry) => entry.path === relativePath);
    if (!file) throw new Error(`Offline dictionary resource is missing from manifest: path=${relativePath}. Disable and re-enable offline dictionaries in Settings to update the download.`);
    const saved = await readRecord<StoredFile>('files', relativePath);
    if (!saved || saved.sha256 !== file.sha256 || !(saved.bytes instanceof ArrayBuffer) || saved.bytes.byteLength !== file.compressedBytes || await hashBytes(saved.bytes) !== file.sha256) {
      throw new Error(`Offline dictionary resource is missing or invalid: path=${relativePath}`);
    }
    const stream = new Blob([saved.bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const bytes = await new Response(stream).arrayBuffer();
    if (bytes.byteLength !== file.uncompressedBytes) throw new Error(`Offline dictionary decompressed size mismatch: path=${relativePath}`);
    try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
    catch (error: unknown) { throw new SyntaxError(`Invalid offline dictionary JSON: path=${relativePath}`, { cause: error }); }
  } catch (error: unknown) {
    if (readRevision === revision && status.enabled) {
      publish({ ...status, phase: 'error', message: error instanceof Error ? error.message : String(error) });
      await enqueue(async (): Promise<void> => {
        if (readRevision !== revision || !status.enabled) return;
        await writeRecord('metadata', { enabled: true, ready: false, manifest: installedManifest }, STATE_KEY);
        channel?.postMessage('changed');
      });
    }
    throw error;
  }
}
