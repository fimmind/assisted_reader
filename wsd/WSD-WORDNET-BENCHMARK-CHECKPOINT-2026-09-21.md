# WordNet WSD benchmark checkpoint

Date: 2026-09-21
Updated: 2026-09-22

## Decision so far

The production direction should remain a target-aware bi-encoder with offline
definition embeddings. Do not ship any checkpoint tested here yet. The generic
retrieval models are not trained for lexical substitution, while the available
specialized checkpoint is a 265 MB DistilBERT model with 768-dimensional
embeddings and is too large for the intended browser path without distillation
and quantization.

The next serious candidate should be a MiniLM-size, target-token-pooling
bi-encoder trained on WordNet/SemCor examples. Precompute one embedding per
WordNet synset, quantize the matrix, encode only the sentence occurrence at
runtime, and fuse the semantic score with WordNet sense order. Select the
number of displayed definitions with a calibration-only confidence policy;
top-1 accuracy alone is not a safe filtering policy.

Published systems such as LENS, BEM, ConSeC, and GlossDeBERTa remain useful
quality references. LENS and BEM most closely validate the bi-encoder design,
but their available research checkpoints/licensing and model sizes do not make
them direct browser dependencies. Cross-encoders remain an upper-bound or
teacher option because they must process every context/gloss pair online.

## Completed work

- Downloaded and prepared Raganato ALL and its five component datasets against
  the local WordNet corpus. The aggregate contains 5,952 ambiguous occurrences.
- Reserved SemEval-2007 (429 occurrences) for calibration. The other four
  datasets provide 5,523 held-out evaluation occurrences.
- Downloaded and prepared CoarseWSD (10,196 examples; 8,002 mapped to WordNet)
  as a separate coarse-sense diagnostic.
- Added `scripts/evaluate_wordnet_filtering.py`. It reports fixed Top 1-3 and
  split-conformal score-margin policies, including mean definitions shown,
  wrong-definition suppression, and unsafe exclusion rate.
- Corrected Raganato's MFS metadata. WordNet synset-wide lemma counts are not
  target-lemma frequencies and gave a misleading 52.86% baseline. The prepared
  data now records WordNet's sense-number order and gives 57.58% on this
  ambiguous-only set.
- Corrected `wordnet-sense-embedding` loading. Its published module reference
  is not resolvable by current `sentence-transformers`, and version 5 calls
  `preprocess()` instead of the helper's `tokenize()`. The ranker now restores
  the pooling module and binds target-mask preprocessing to the actual encoding
  path. A real-checkpoint regression test verifies that the mask reaches pooling.
- Corrected model downloads to include PyTorch `.bin` weights. This made the
  438 MB `Babelscape/wsl-retriever-e5-base-v2` checkpoint available locally;
  its CC-BY-NC-SA license still makes it a research reference only.
- Added exact target-occurrence markers, normalized candidate POS fields,
  stable synset deduplication, persistent definition-embedding caches,
  resumable score checkpoints, and result provenance.
- Built the project-local Python environment on Android/aarch64 and smoke-tested
  every accessible ranker checkpoint.

## Verified results

Full Raganato ALL baselines:

| Ranker | Top-1 | MRR | Throughput |
|---|---:|---:|---:|
| MFS / WordNet sense order | 57.58% | 0.7348 | 31,362 examples/s |
| Lexical overlap | 26.93% | 0.5045 | 946 examples/s |

The original neural smoke timings below predate exact occurrence markers and
the repaired target-mask preprocessing. They are retained only as historical
device-cost estimates and must not be used for model-quality comparison:

| Ranker | Local files | Smoke throughput |
|---|---:|---:|
| Arctic Embed XS bi-encoder | 91 MB | 0.95 examples/s |
| E5-small-v2 bi-encoder | 134 MB | 0.59 examples/s |
| all-MiniLM-L6-v2 bi-encoder | 92 MB | 1.28 examples/s |
| WordNet target-aware bi-encoder | 533 MB | 0.45 examples/s |
| TinyBERT-L2 cross-encoder | 19 MB | 10.92 examples/s |
| MiniLM-L2 cross-encoder | 63 MB | 2.56 examples/s |
| MiniLM-L6 cross-encoder | 92 MB | 0.82 examples/s |

New smoke runs are written separately from complete results and record their
sample limit, dataset hash, model revision, dependency versions, and completion
status. Definition embeddings are deduplicated and cached between runs.

## Validation status

- `python -m compileall -q wsd/scripts wsd/tests`: passed
- `wsd/.venv/bin/python -m unittest discover -s wsd/tests -v`: 15/15 passed
- `git diff --check`: passed
- Specialized WordNet target-mask integration test: passed
- WSL `.bin` checkpoint download and inference smoke test: passed
- Full specialized-model run: intentionally stopped after the user reported
  that the execution window had 2% remaining; no partial result was presented
  as a completed benchmark

## Exact continuation

From the repository root, use the existing project-local environment:

```sh
wsd/.venv/bin/python -m unittest discover -s wsd/tests -v
wsd/.venv/bin/python wsd/scripts/evaluate_wordnet_filtering.py \
  --model wordnet-sense-embedding minilm e5-small arctic-embed-xs \
  tinybert-cross-encoder minilm-l2-cross-encoder minilm-l6-cross-encoder
```

Run that long benchmark while the device can remain powered and thermally
stable. The first priority afterward is a stratified product dataset built from
the site's actual WordNet cards. Raganato has one exact gold synset and can
over-penalize other definitions that would still be useful to a reader, so the
final launch decision must use human `fits` / `plausible` / `clearly_wrong`
labels and minimize unsafe exclusions rather than maximize academic top-1.
