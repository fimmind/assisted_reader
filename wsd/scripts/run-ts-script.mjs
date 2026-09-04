import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/run-ts-script.mjs <script.mts>');
let build;
try {
  ({ build } = await import('esbuild'));
} catch {
  const pnpmRoot = path.resolve('node_modules/.pnpm');
  const packageDir = (await fs.readdir(pnpmRoot)).find((name) => name.startsWith('esbuild@'));
  if (!packageDir) throw new Error('esbuild is unavailable; install the repository dependencies first.');
  ({ build } = await import(pathToFileURL(path.join(pnpmRoot, packageDir, 'node_modules/esbuild/lib/main.js')).href));
}
const output = path.join(os.tmpdir(), `assisted-reader-${process.pid}-${Date.now()}.mjs`);
try {
  await build({ entryPoints: [path.resolve(source)], outfile: output, bundle: true, platform: 'node', format: 'esm' });
  await import(pathToFileURL(output).href);
} finally {
  await fs.rm(output, { force: true });
}
