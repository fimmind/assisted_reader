import fs from 'node:fs/promises';
import path from 'node:path';
import nlp from 'compromise';

import { tagSentenceTerms } from '../../src/core/nlp';
import { taggedTermStarts } from './tagged-term-offsets';

type DraftExample = {
  id: string;
  context: string;
  target: string;
  target_start?: number;
  source: { token_index: number };
};

const sourcePath = process.argv[3];
if (!sourcePath) throw new Error('Usage: node scripts/run-ts-script.mjs scripts/backfill-target-starts.mts <draft.jsonl>');
const absolutePath = path.resolve(sourcePath);
const examples = (await fs.readFile(absolutePath, 'utf8'))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as DraftExample);
const updated = examples.map((example) => {
  const terms = tagSentenceTerms(example.context, nlp as never);
  const tokenIndex = example.source.token_index;
  const term = terms[tokenIndex];
  const targetStart = taggedTermStarts(example.context, terms)[tokenIndex];
  if (!term || term.raw !== example.target || targetStart === null || targetStart === undefined) {
    throw new Error(`Cannot locate target occurrence: id=${example.id} token_index=${tokenIndex} target=${JSON.stringify(example.target)}`);
  }
  if (example.target_start !== undefined && example.target_start !== targetStart) {
    throw new Error(`Stored target offset differs from source token: id=${example.id} old=${example.target_start} new=${targetStart}`);
  }
  return { ...example, target_start: targetStart };
});
const temporaryPath = `${absolutePath}.tmp`;
await fs.writeFile(temporaryPath, updated.map((example) => JSON.stringify(example)).join('\n') + '\n', 'utf8');
await fs.rename(temporaryPath, absolutePath);
console.log(`wrote target starts for ${updated.length} examples to ${absolutePath}`);
