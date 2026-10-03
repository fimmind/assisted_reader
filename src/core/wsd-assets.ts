import type { WsdMode } from './types';

export type ActiveWsdMode = Exclude<WsdMode, 'none'>;
export interface WsdAssetAvailability {
  checked: boolean;
  available: boolean;
  reason: string;
}
export type WsdAvailability = Record<ActiveWsdMode, WsdAssetAvailability>;
export interface FailedWsdAsset { mode: ActiveWsdMode; url: string }

const DIRECTORIES: Record<ActiveWsdMode, string> = {
  sayedshaun: 'sayedshaun-wsd', 'glite-lens': 'glite-lens', ettin: 'ettin-150m-wsd',
};

export function uncheckedWsdAvailability(): WsdAvailability {
  return {
    sayedshaun: { checked: false, available: false, reason: 'Checking model assets' },
    'glite-lens': { checked: false, available: false, reason: 'Checking model assets' },
    ettin: { checked: false, available: false, reason: 'Checking model assets' },
  };
}

async function inspectModelAssets(mode: ActiveWsdMode, serverStatus: WsdAssetAvailability,
  failed: FailedWsdAsset | null, signal: AbortSignal): Promise<WsdAssetAvailability> {
  if (!serverStatus.available) return { ...serverStatus, checked: true };
  const root = `${import.meta.env.BASE_URL}wsd/${DIRECTORIES[mode]}/`;
  try {
    const response = await fetch(`${root}manifest.json`, { cache: 'no-store', signal });
    if (!response.ok) throw new Error(`Model manifest unavailable: status=${response.status}`);
    const payload = await response.json() as { parts?: { name: string }[]; metadata?: Record<string, string> };
    if (!Array.isArray(payload.parts) || payload.parts.length < 1 || payload.parts.length > 20
      || !payload.parts.every((part, index) => part.name === `model.part${String(index).padStart(2, '0')}`)
      || !payload.metadata || !Object.keys(payload.metadata).every((name) =>
        ['tokenizer.json', 'tokenizer_config.json', 'answer_letters.json'].includes(name))) {
      throw new TypeError('Invalid model manifest.');
    }
    const urls = [...payload.parts.map((part) => `${root}${part.name}`),
      ...Object.keys(payload.metadata).map((name) => `${root}${name}`)];
    if (failed?.mode === mode) urls.push(failed.url);
    await Promise.all(urls.map(async (url) => {
      const asset = await fetch(url, { method: 'HEAD', cache: 'no-store', signal });
      if (!asset.ok) throw new Error(`Model asset unavailable: url=${url} status=${asset.status}`);
    }));
    return { checked: true, available: true, reason: '' };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return { checked: true, available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Probe server inventory and model headers; sense vectors remain lazy downloads. */
export async function loadWsdAvailability(failed: FailedWsdAsset | null, signal: AbortSignal): Promise<WsdAvailability> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}wsd/availability.json`, { cache: 'no-store', signal: requestSignal });
    if (!response.ok) throw new Error(`Asset availability check failed: status=${response.status}`);
    const payload = await response.json() as WsdAvailability;
    const modes = Object.keys(DIRECTORIES) as ActiveWsdMode[];
    for (const mode of modes) {
      if (typeof payload[mode]?.available !== 'boolean' || typeof payload[mode]?.reason !== 'string') {
        throw new TypeError(`Invalid asset availability response: model=${mode}`);
      }
    }
    const results = await Promise.all(modes.map((mode) => inspectModelAssets(mode, payload[mode], failed, requestSignal)));
    return { sayedshaun: results[0], 'glite-lens': results[1], ettin: results[2] };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    const unavailable: WsdAssetAvailability = { checked: true, available: false,
      reason: error instanceof Error ? error.message : String(error) };
    return { sayedshaun: unavailable, 'glite-lens': unavailable, ettin: unavailable };
  }
}

export function failedWsdAsset(mode: WsdMode, phase: string, message: string): FailedWsdAsset | null {
  if (mode === 'none' || phase !== 'error') return null;
  const url = message.match(/url=(\S+) /)?.[1];
  if (!url) return null;
  const resolved = new URL(url, location.href);
  const root = new URL(`${import.meta.env.BASE_URL}wsd/${DIRECTORIES[mode]}/`, location.href);
  return resolved.origin === root.origin && resolved.pathname.startsWith(root.pathname)
    ? { mode, url: resolved.href } : null;
}
