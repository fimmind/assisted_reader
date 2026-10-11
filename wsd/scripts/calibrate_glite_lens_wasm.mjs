/** Calibrate Glite LENS margins with the site's WASM context tower. */
import { readFileSync, writeFileSync } from 'node:fs';
import { Tokenizer } from '@huggingface/tokenizers';
import * as ort from 'onnxruntime-web/wasm';

const root = new URL('../', import.meta.url);
const source = new URL('.cache/glite-lens-calibration-input.json', root);
const output = new URL('results/glite-lens-wasm-calibration.json', root);
const model = new URL('.cache/exports/glite-lens/model-int8.onnx', root);
const tokenizerPath = new URL('.cache/exports/glite-lens/tokenizer.json', root);
const configPath = new URL('.cache/exports/glite-lens/tokenizer_config.json', root);
const wasmPath = new URL('../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', import.meta.url);
const examples = JSON.parse(readFileSync(source, 'utf8'));
const tokenizer = new Tokenizer(JSON.parse(readFileSync(tokenizerPath, 'utf8')),
  JSON.parse(readFileSync(configPath, 'utf8')));
const wasm = readFileSync(wasmPath);
ort.env.wasm.wasmBinary = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength);
ort.env.wasm.numThreads = 1;
const bytes = readFileSync(model);
const session = await ort.InferenceSession.create(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  { executionProviders: ['wasm'], graphOptimizationLevel: 'all' },
);
const gaps = [];
for (let index = 0; index < examples.length; index += 1) {
  const example = examples[index];
  const tokenIds = tokenizer.encode(example.text, { add_special_tokens: false }).ids;
  const firstTarget = Math.min(tokenizer.encode(example.text.slice(0, example.start).trimEnd(),
    { add_special_tokens: false }).ids.length, tokenIds.length - 1);
  const endTarget = Math.max(firstTarget + 1, Math.min(tokenizer.encode(example.text.slice(0, example.end),
    { add_special_tokens: false }).ids.length, tokenIds.length));
  let first = 0;
  if (tokenIds.length > 322) {
    first = Math.max(0, firstTarget - Math.floor(322 * 0.75));
    if (endTarget - 1 >= first + 322) first = endTarget - 322;
    first = Math.min(first, tokenIds.length - 322);
  }
  const selected = tokenIds.slice(first, first + 322);
  const ids = [50281, ...selected, 50282];
  const mask = [0, ...selected.map((_, tokenIndex) => Number(first + tokenIndex >= firstTarget
    && first + tokenIndex < endTarget)), 0];
  const result = await session.run({
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    attention_mask: new ort.Tensor('int64', BigInt64Array.from(ids, () => 1n), [1, ids.length]),
    target_mask: new ort.Tensor('float32', Float32Array.from(mask), [1, ids.length]),
  });
  const context = result.embedding.data;
  const scores = example.vectors.map((vector) => vector.reduce((sum, value, dimension) =>
    sum + value * context[dimension], 0));
  const gold = example.gold.map((candidate) => scores[candidate]);
  if (gold.length === 0) throw new Error(`Missing Glite LENS gold sense: id=${example.id}`);
  gaps.push(Math.max(...scores) - Math.max(...gold));
  if (index % 50 === 0) console.log(JSON.stringify({ completed: index, total: examples.length }));
}
const ordered = gaps.toSorted((left, right) => left - right);
const margins = Array.from({ length: 11 }, (_, level) => level === 0
  ? ordered.at(-1) + 0.01
  : ordered[Math.ceil((ordered.length + 1) * (1 - level / 100)) - 1]);
writeFileSync(output, `${JSON.stringify({ model: 'glite-lens-seed42-int8-wasm', examples: examples.length, margins }, null, 2)}\n`);
console.log(JSON.stringify({ output: output.pathname, margins }));
await session.release();
