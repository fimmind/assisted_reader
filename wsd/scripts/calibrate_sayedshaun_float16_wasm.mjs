/** Calibrate SayedShaun margins with stored float16 glosses and the site's WASM encoder. */
import { readFileSync, writeFileSync } from 'node:fs';
import { Tokenizer } from '@huggingface/tokenizers';
import * as ort from 'onnxruntime-web/wasm';

const root = new URL('../', import.meta.url);
const source = new URL('.cache/sayedshaun-calibration-input.json', root);
const output = new URL('results/sayedshaun-float16-wasm-calibration.json', root);
const model = new URL('.cache/exports/sayedshaun-wsd/model-int8.onnx', root);
const tokenizerPath = new URL('.cache/exports/sayedshaun-wsd/tokenizer.json', root);
const configPath = new URL('.cache/exports/sayedshaun-wsd/tokenizer_config.json', root);
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
  const marked = `${example.text.slice(0, example.start)}<classify>${example.text.slice(example.start, example.end)}</classify>${example.text.slice(example.end)}`;
  const encoded = tokenizer.encode(marked, { add_special_tokens: true }).ids;
  const ids = encoded.length <= 256 ? encoded : [...encoded.slice(0, 255), 102];
  const result = await session.run({
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    attention_mask: new ort.Tensor('int64', BigInt64Array.from(ids, () => 1n), [1, ids.length]),
  });
  const context = result.embedding.data;
  const scores = example.vectors.map((vector) => vector.reduce((sum, value, dimension) =>
    sum + value * context[dimension], 0));
  const gold = example.gold.map((candidate) => scores[candidate]);
  if (gold.length === 0) throw new Error(`Missing SayedShaun gold sense: id=${example.id}`);
  gaps.push(Math.max(...scores) - Math.max(...gold));
  if (index % 50 === 0) console.log(JSON.stringify({ completed: index, total: examples.length }));
}
const ordered = gaps.toSorted((left, right) => left - right);
const margins = Array.from({ length: 11 }, (_, level) => level === 0
  ? ordered.at(-1) + 0.01
  : ordered[Math.ceil((ordered.length + 1) * (1 - level / 100)) - 1]);
writeFileSync(output, `${JSON.stringify({ model: 'sayedshaun-int8-float16-wasm', examples: examples.length, margins }, null, 2)}\n`);
console.log(JSON.stringify({ output: output.pathname, margins }));
await session.release();
