import { COMPROMISE_CDN_URL, JSZIP_CDN_URL } from './constants';

type JsZipGlobal = {
  loadAsync: (data: ArrayBuffer) => Promise<JsZipFile>;
};

type JsZipFile = {
  files: Record<string, { dir?: boolean }>;
  file: (path: string) => { async: (kind: 'string') => Promise<string> } | null;
};

type CompromiseDoc = {
  terms: () => {
    json: () => Array<{ text?: string; normal?: string; tags?: string[]; terms?: Array<{ text?: string; normal?: string; tags?: string[] }> }>;
  };
  verbs: () => { toInfinitive: () => { out: (format: 'text') => string } };
  nouns: () => { toSingular: () => { out: (format: 'text') => string } };
  adjectives: () => { conjugate: () => Array<Record<string, string>> };
};

type CompromiseGlobal = {
  (text: string): CompromiseDoc;
};

declare global {
  interface Window {
    JSZip?: JsZipGlobal;
    nlp?: CompromiseGlobal;
  }
}

function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const selector = `script[data-easeword-src="${url}"]`;
    const existing = document.querySelector<HTMLScriptElement>(selector);
    if (existing) {
      if (existing.dataset.loaded === '1') {
        resolve();
        return;
      }
      if (existing.dataset.failed === '1') {
        existing.remove();
      } else {
        const timeout = window.setTimeout(() => {
          reject(new Error(`Timed out waiting for script load: ${url}`));
        }, 15000);
        existing.addEventListener('load', () => {
          window.clearTimeout(timeout);
          resolve();
        }, { once: true });
        existing.addEventListener('error', () => {
          window.clearTimeout(timeout);
          existing.dataset.failed = '1';
          reject(new Error(`Failed to load script: ${url}`));
        }, { once: true });
        return;
      }
    }

    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.dataset.easewordSrc = url;
    script.addEventListener('load', () => {
      script.dataset.loaded = '1';
      resolve();
    });
    script.addEventListener('error', () => {
      script.dataset.failed = '1';
      reject(new Error(`Failed to load script: ${url}`));
    }, { once: true });
    document.head.appendChild(script);
  });
}

export async function loadJsZip(): Promise<JsZipGlobal> {
  if (window.JSZip) {
    return window.JSZip;
  }
  await loadScript(JSZIP_CDN_URL);
  if (!window.JSZip) {
    throw new Error('JSZip failed to initialize after script load.');
  }
  return window.JSZip;
}

export async function loadCompromise(): Promise<CompromiseGlobal | null> {
  if (window.nlp) {
    return window.nlp;
  }

  let scriptLoaded = false;
  try {
    await loadScript(COMPROMISE_CDN_URL);
    scriptLoaded = true;
  } catch (error) {
    console.warn('compromise-load-failed', { error });
  }
  if (!window.nlp) {
    try {
      const module = await import('compromise');
      const fallback = typeof module.default === 'function'
        ? module.default
        : (typeof module === 'function' ? module : null);
      if (fallback) {
        return fallback as CompromiseGlobal;
      }
      console.warn('compromise-module-invalid', { scriptLoaded });
      return null;
    } catch (error) {
      console.warn('compromise-module-load-failed', { error, scriptLoaded });
      return null;
    }
  }
  return window.nlp;
}
