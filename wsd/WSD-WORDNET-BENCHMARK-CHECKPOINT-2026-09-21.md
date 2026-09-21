# WordNet WSD benchmark checkpoint

Date: 2026-09-21

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
  is not resolvable by current `sentence-transformers`, which silently loaded
  whole-sentence mean pooling. The ranker now retains the custom tokenizer and
  explicitly restores target-word pooling.
- Hardened model downloads so a gated repository with configuration but no
  weights is an explicit error. This exposed `Babelscape/wsl-retriever-e5-base-v2`
  as unavailable without accepting its non-commercial access terms.
- Built the project-local Python environment on Android/aarch64 and smoke-tested
  every accessible ranker checkpoint.

## Verified results

Full Raganato ALL baselines:

| Ranker | Top-1 | MRR | Throughput |
|---|---:|---:|---:|
| MFS / WordNet sense order | 57.58% | 0.7348 | 31,362 examples/s |
| Lexical overlap | 26.93% | 0.5045 | 946 examples/s |

The neural smoke test used only the first eight examples. Its accuracy is not
statistically meaningful; it verifies loading, scoring, model size, and rough
device feasibility:

| Ranker | Local files | Smoke throughput |
|---|---:|---:|
| Arctic Embed XS bi-encoder | 91 MB | 0.95 examples/s |
| E5-small-v2 bi-encoder | 134 MB | 0.59 examples/s |
| all-MiniLM-L6-v2 bi-encoder | 92 MB | 1.28 examples/s |
| WordNet target-aware bi-encoder | 533 MB | 0.45 examples/s |
| TinyBERT-L2 cross-encoder | 19 MB | 10.92 examples/s |
| MiniLM-L2 cross-encoder | 63 MB | 2.56 examples/s |
| MiniLM-L6 cross-encoder | 92 MB | 0.82 examples/s |

These smoke timings include re-encoding definitions. The new filtering
evaluator times definition encoding separately so a completed bi-encoder run
will measure the intended precomputed deployment path.

## Validation status

- `python -m compileall -q wsd/scripts wsd/tests`: passed
- `python -m unittest discover -s wsd/tests -v`: 11/11 passed
- `git diff --check`: passed
- All seven accessible neural rankers: real-checkpoint smoke test passed
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
