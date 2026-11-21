/** Exercise real compressed dictionary downloads and local lookups in Chromium. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [baseUrl, executable] = process.argv.slice(2);
if (!baseUrl || !executable) throw new Error('Usage: node scripts/test-offline-dictionaries-browser.mjs <Vite base URL> <Chromium executable>');
const root = new URL(baseUrl);
const profile = await mkdtemp(path.join(tmpdir(), 'reader-offline-browser-'));
const browser = spawn(executable, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const browserClosed = new Promise((resolve) => { browser.once('exit', resolve); browser.once('error', resolve); });
let diagnostic = '';
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Chromium startup timed out: ${diagnostic}`)), 15000);
    browser.once('error', reject);
    browser.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Chromium exited: code=${code} ${diagnostic}`)); });
    browser.stderr.on('data', (chunk) => {
      diagnostic += chunk.toString();
      const match = diagnostic.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  let session = null;
  let interception = 'corrupt';
  let injectedFailures = 0;
  const forbiddenRequests = [];
  const protocolErrors = [];
  const pending = new Map();
  const loadWaiters = [];
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: method=${method}`)); }, 180000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  socket.addEventListener('message', (message) => {
    const event = JSON.parse(message.data);
    if (event.id) {
      const request = pending.get(event.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(event.id);
      if (event.error) request.reject(new Error(JSON.stringify(event.error)));
      else request.resolve(event.result);
    } else if (event.method === 'Page.loadEventFired') {
      for (const resolve of loadWaiters.splice(0)) resolve();
    } else if (event.method === 'Fetch.requestPaused') {
      const { requestId, request } = event.params;
      let response;
      if (interception === 'deny') {
        forbiddenRequests.push(request.url);
        response = send('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' }, session);
      } else if (interception === 'corrupt' && request.url.endsWith('/offline-dictionaries/lexicon/0000.json.bin')) {
        injectedFailures += 1;
        response = send('Fetch.fulfillRequest', { requestId, responseCode: 200, body: Buffer.from('damaged gzip download').toString('base64') }, session);
      } else response = send('Fetch.continueRequest', { requestId }, session);
      void response.catch((error) => protocolErrors.push(error.message));
    }
  });
  const target = await send('Target.createTarget', { url: 'about:blank' }, null);
  session = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId;
  await send('Page.enable', {}, session);
  await send('Runtime.enable', {}, session);
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression: `(async()=>(${expression}))()`, awaitPromise: true, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (expression, description) => {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Browser condition timed out: ${description}`);
  };
  const moduleUrl = new URL('src/core/offline-dictionaries.ts', root).href;
  const lexiconUrl = new URL('src/core/lexicon.ts', root).href;
  const searchUrl = new URL('src/core/dictionary-search.ts', root).href;
  const core = `await import(${JSON.stringify(moduleUrl)})`;
  const settingsUrl = new URL('settings', root).href;
  const toggle = "document.querySelector('[data-testid=toggle-offline-dictionaries]')";
  const state = `(await (${core}).getOfflineDictionaryStatus())`;
  await send('Page.navigate', { url: settingsUrl }, session);
  await waitFor(`${toggle} && !${toggle}.disabled`, 'settings toggle');
  const online = await evaluate(`(async()=>{const m=await import(${JSON.stringify(lexiconUrl)});return {wordnet:await m.createLazyWordNet(${JSON.stringify(root.pathname)}).lookup('bank'),wiktionary:await m.createLazyWiktionaryLexicon(${JSON.stringify(root.pathname)}).lookup('bank')};})()`);
  assert.ok(online.wordnet.senses.length);
  await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Start reading first')?.click()");
  const patterns = ['*/data/lexicon/*', '*/data/wordnet/*', '*/data/lemma_dict.json', '*/data/offline-dictionaries/*'].map((urlPattern) => ({ urlPattern }));
  await send('Fetch.enable', { patterns }, session);
  await evaluate(`${toggle}.click()`);
  await waitFor(`(async()=>{const s=${state};return s.phase==='error';})()`, 'corrupt download error');
  const failedDownload = await evaluate(state);
  assert.equal(injectedFailures, 3, `Damaged downloads must be retried three times: ${JSON.stringify(failedDownload)}`);
  assert.match(failedDownload.message, /checksum|size/i);
  console.log('Corrupt download rejected after three attempts.');
  interception = 'pass';
  await evaluate("document.querySelector('[data-testid=button-retry-offline-dictionaries]').click()");
  await waitFor(`(async()=>{const s=${state};if(s.phase==='error')throw new Error(s.message);return s.phase==='ready';})()`, 'full download');
  const installed = await evaluate(state);
  const storage = await evaluate(`(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('easeword-offline-dictionaries');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});try{return await new Promise((resolve,reject)=>{const r=db.transaction('files').objectStore('files').getAll();r.onsuccess=()=>resolve({files:r.result.length,bytes:r.result.reduce((n,f)=>n+f.bytes.byteLength,0),gzip:r.result.every(f=>{const b=new Uint8Array(f.bytes);return b[0]===31&&b[1]===139})});r.onerror=()=>reject(r.error)})}finally{db.close()}})()`);
  const manifest = await evaluate(`(await (await fetch(${JSON.stringify(new URL('data/offline-dictionaries/manifest.json', root).href)})).json())`);
  assert.equal(storage.files, manifest.files.length);
  assert.equal(storage.bytes, installed.totalBytes);
  assert.equal(storage.gzip, true);
  console.log(`Stored ${storage.files} compressed assets (${(storage.bytes / 1048576).toFixed(2)} MiB).`);
  interception = 'deny';
  const local = await evaluate(`(async()=>{const m=await import(${JSON.stringify(lexiconUrl)});return {wordnet:await m.createLazyWordNet(${JSON.stringify(root.pathname)}).lookup('bank'),wiktionary:await m.createLazyWiktionaryLexicon(${JSON.stringify(root.pathname)}).lookup('bank')};})()`);
  assert.deepEqual(local, online);
  const legacy = await evaluate(`(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('easeword-offline-dictionaries');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});try{const state=await new Promise((resolve,reject)=>{const r=db.transaction('metadata').objectStore('metadata').get('state');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});const headwords=state.manifest.files.find(file=>file.path==='data/lexicon/headwords.json');if(!headwords)throw new Error('Installed manifest lacks headwords');const files=state.manifest.files.filter(file=>file.path!==headwords.path);const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(files)));const version=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');const legacyState={...state,ready:false,manifest:{...state.manifest,files,totalBytes:state.manifest.totalBytes-headwords.compressedBytes,version}};await new Promise((resolve,reject)=>{const t=db.transaction(['metadata','files'],'readwrite');t.objectStore('metadata').put(legacyState,'state');t.objectStore('files').delete(headwords.path);t.oncomplete=resolve;t.onabort=()=>reject(t.error)});return {files:files.length,totalBytes:legacyState.manifest.totalBytes,version}}finally{db.close()}})()`);
  assert.equal(legacy.files, manifest.files.length - 1);
  assert.notEqual(legacy.version, manifest.version);
  const reload = async () => {
    const reloaded = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Reload timed out')), 60000);
      loadWaiters.push(() => { clearTimeout(timeout); resolve(); });
    });
    await send('Page.reload', { ignoreCache: true }, session);
    await reloaded;
    await waitFor(`${toggle} && !${toggle}.disabled`, 'reload settings');
  };
  await reload();
  const search = `await (await import(${JSON.stringify(searchUrl)})).searchDictionary('fin',0)`;
  const migratedSearch = await evaluate(search);
  assert.equal(migratedSearch.entries[0]?.word, 'fin', 'Exact headword must come first');
  assert.ok(migratedSearch.entries.some((entry) => entry.word === 'find'), 'Prefix search must include find');
  assert.equal((await evaluate(state)).phase, 'ready');
  const persistedIndex = await evaluate(`(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('easeword-offline-dictionaries');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});try{return await new Promise((resolve,reject)=>{const t=db.transaction(['metadata','files']);const state=t.objectStore('metadata').get('state');const file=t.objectStore('files').get('data/lexicon/headwords.json');t.oncomplete=()=>resolve({ready:state.result.ready,descriptor:state.result.manifest.files.find(item=>item.path==='data/lexicon/headwords.json'),totalBytes:state.result.manifest.totalBytes,file:file.result&&{sha256:file.result.sha256,bytes:file.result.bytes.byteLength}});t.onabort=()=>reject(t.error)})}finally{db.close()}})()`);
  assert.equal(persistedIndex.ready, true);
  assert.ok(persistedIndex.descriptor, 'Migrated manifest must contain the headwords index');
  assert.equal(persistedIndex.file?.sha256, persistedIndex.descriptor.sha256);
  assert.equal(persistedIndex.file?.bytes, persistedIndex.descriptor.compressedBytes);
  assert.equal(persistedIndex.totalBytes, legacy.totalBytes + persistedIndex.descriptor.compressedBytes);
  await reload();
  assert.equal((await evaluate(state)).phase, 'ready');
  assert.deepEqual(await evaluate(search), migratedSearch, 'Migrated prefix search must survive a second reload');
  assert.deepEqual(forbiddenRequests, [], 'Legacy migration and searches must make no dictionary requests');
  console.log('Legacy offline install rebuilt and persisted its prefix index without dictionary requests.');
  const lookups = await evaluate(`(async()=>{const m=await import(${JSON.stringify(lexiconUrl)});const w=m.createLazyWordNet(${JSON.stringify(root.pathname)});const d=m.createLazyWiktionaryLexicon(${JSON.stringify(root.pathname)});const words=['bank','run','apple','cat','reader','ambiguity','go','make','love','dictionary'];return Promise.all(words.map(async word=>({word,wordnet:!!await w.lookup(word),wiktionary:!!await d.lookup(word)})))})()`);
  assert.ok(lookups.every((entry) => entry.wordnet && entry.wiktionary));
  const lemmaCount = await evaluate(`(async()=>{const m=await import(${JSON.stringify(new URL('src/core/lemma.ts', root).href)});return Object.keys(await m.loadLemmaDict()).length})()`);
  assert.ok(lemmaCount > 0, 'Lemma and inflection resources must load locally');
  assert.deepEqual(forbiddenRequests, [], 'Installed dictionaries must make no dictionary requests, including after reload');
  console.log('Definitions match online data; reload and unseen-word lookups made zero dictionary requests.');
  await evaluate(`${toggle}.scrollIntoView({block:'center'})`);
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, session);
  await writeFile(path.join(profile, 'settings.png'), Buffer.from(screenshot.data, 'base64'));
  if (process.env.OFFLINE_DICTIONARY_SCREENSHOT) await writeFile(process.env.OFFLINE_DICTIONARY_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  await evaluate(`(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('easeword-offline-dictionaries');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});try{await new Promise((resolve,reject)=>{const t=db.transaction('files','readwrite');t.objectStore('files').delete('data/wordnet/0000.json');t.oncomplete=resolve;t.onabort=()=>reject(t.error)})}finally{db.close()}})()`);
  const missingResource = await evaluate(`(async()=>{try{await (${core}).readDictionaryResource('data/wordnet/0000.json',${JSON.stringify(root.pathname)});throw new Error('Missing local asset unexpectedly succeeded')}catch(error){return error.message}})()`);
  assert.match(missingResource, /missing or invalid/);
  assert.equal((await evaluate(state)).phase, 'error');
  assert.deepEqual(forbiddenRequests, [], 'Missing offline assets must fail without a remote fallback');
  console.log('Missing local assets report an error without requesting server data.');
  interception = 'pass';
  await evaluate(`${toggle}.click()`);
  await waitFor(`(async()=>{const s=${state};return !s.enabled&&s.phase==='idle';})()`, 'disable and deletion');
  interception = 'pass';
  await evaluate(`${toggle}.click()`);
  await waitFor(`(async()=>{const s=${state};return s.phase==='downloading';})()`, 'second download started');
  await evaluate(`${toggle}.click()`);
  await waitFor(`(async()=>{const s=${state};return !s.enabled&&s.phase==='idle';})()`, 'cancel and cleanup');
  const remaining = await evaluate(`(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('easeword-offline-dictionaries');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});try{return await new Promise((resolve,reject)=>{const r=db.transaction('files').objectStore('files').count();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}finally{db.close()}})()`);
  assert.equal(remaining, 0);
  assert.deepEqual(protocolErrors, []);
  console.log('Disabling and cancelling remove local assets without a stale download becoming ready.');
} finally {
  socket?.close();
  browser.kill('SIGTERM');
  await browserClosed;
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
