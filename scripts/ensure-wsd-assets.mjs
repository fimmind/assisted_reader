import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const fileName = 'ort-wasm-simd-threaded.wasm';
const source = path.join(root, 'node_modules', 'onnxruntime-web', 'dist', fileName);
const destination = path.join(root, 'public', 'wsd', 'onnxruntime', fileName);

if (!existsSync(source)) {
  throw new Error(`Missing ONNX Runtime browser binary: source=${source}`);
}

mkdirSync(path.dirname(destination), { recursive: true });
copyFileSync(source, destination);
