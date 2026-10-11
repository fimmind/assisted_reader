import path from 'node:path';
import { inspectWsdAssets } from './wsd-assets.mjs';

const availability = await inspectWsdAssets(path.resolve('public/wsd'));
for (const [model, status] of Object.entries(availability)) {
  if (!status.available) {
    console.warn('wsd-assets-unavailable', { model, reason: status.reason,
      build: 'pnpm ensure:wsd', message: 'Dev mode does not generate WSD assets. Build them in another terminal, then refresh Settings.' });
  }
}
