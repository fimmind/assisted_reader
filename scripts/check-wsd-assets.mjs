import path from 'node:path';
import { inspectWsdAssets } from './wsd-assets.mjs';

const availability = await inspectWsdAssets(path.resolve('public/wsd'));
for (const [model, status] of Object.entries(availability)) {
  if (!status.available) {
    console.warn('wsd-assets-unavailable', { model, reason: status.reason,
      build: 'pnpm ensure:wsd', message: 'Run pnpm run ensure:wsd to generate assets on desktop or download them on Termux, then refresh Settings.' });
  }
}
