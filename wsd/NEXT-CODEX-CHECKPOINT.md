# Assisted Reader WSD checkpoint - 2026-09-03

## Product invariant

Never suppress candidate definitions. Rank every runtime definition for the
clicked entry. The objective is to demote `clearly_wrong` senses, not to force
fine-grained single-sense selection.

## Workspace and environment

- Repository: `C:\Users\user\Desktop\suff\assisted_reader`
- Benchmark directory: `wsd\`
- Python environment: `wsd\.venv`
- Dependencies and model/data caches are intentionally ignored by Git.
- Use `uv run python ...` from `wsd\` when `uv` is available. Existing local
  environment also supports `.venv\Scripts\python.exe`.

## Product lookup/POS facts

- `src/core/nlp.ts`: Compromise derives POS and deinflects tagged terms.
- `src/core/definition-target.ts`: lookup tries the exact displayed form before
  lemma fallback.
- `src/core/lexicon.ts`: matching POS groups are preferred only when present;
  otherwise all groups are displayed.
- Dataset drafting initially lost POS by resolving lemmas too early. Fixed in
  `scripts/build_reader_dev_draft.py`: exact display form first, contextual POS
  stored with each example.

## Data state

| File | State | Notes |
| --- | --- | --- |
| `data/processed/raganato-all.jsonl` | ready/evaluated | 5,952 candidate-complete WordNet examples. |
| `data/processed/coarsewsd-20-test.jsonl` | ready, not evaluated | 10,196 examples; 8,002 mapped to WordNet gold labels. |
| `data/processed/reader-dev-v1.jsonl` | approved development data | 28 multi-definition entries, 363 candidates. |
| `data/reader-dev-v1-draft.jsonl` | source traceability | 29 entries; one single-candidate entry is excluded from benchmark. |
| `data/reader-dev-v1-review.html` | review UI | Self-contained, loaded labels and CSV import/export. |

Labels in `reader-dev-v1` were conservatively prefilled by the assistant and
reviewed/approved by the user. This is development data, not a held-out final
test set. Do not tune indefinitely against it; create a separate frozen
`reader-test-v1` before selecting a production model.

## Implemented rankers

In `scripts/rankers.py`:

- `mfs`: WordNet MFS when frequencies exist. On reader candidates with no
  frequency field it is dictionary input order; call it that in reports.
- `pos-mfs`, `pos-order`: preserve all candidates and boost only matching POS.
- `e5-small`: `intfloat/e5-small-v2` contextual/gloss cosine scorer.
- `wordnet-sense-embedding`: `marksverdhei/wordnet-sense-embedding`, adapted
  with transformer + custom target-token pooling because its remote-code loader
  has a Windows path issue.
- `pos-e5-small`, `pos-wordnet-sense-embedding`: POS-first wrappers.

POS boost is `2.1`, intentionally greater than the cosine score range. It is a
deterministic group ordering, not a score calibration.

## Verified results

### Raganato ALL

`results/raganato-all-benchmark.csv`

| Model | Top-1 exact | MRR |
| --- | ---: | ---: |
| `mfs` | 0.5286 | 0.7054 |
| `e5-small` | 0.3140 | 0.5359 |
| `wordnet-sense-embedding` | 0.4503 | 0.6453 |

No POS-aware Raganato runs have been recorded yet. Neural full runs are slow
enough that the tool's default 30-second window can time out; use a longer
execution window or an interactive session.

### Reader dev v1

`results/reader-dev-v1-benchmark.csv`

| Model | Top-1 acceptable | CER@1 | MRR first acceptable | Pairwise acceptable > wrong |
| --- | ---: | ---: | ---: | ---: |
| dictionary order / MFS proxy | 0.5357 | 0.4643 | 0.6564 | 0.0000 |
| `pos-order` | 0.7500 | 0.2500 | 0.8295 | 0.4867 |
| `pos-e5-small` | 0.3929 | 0.6071 | 0.5543 | 0.7933 |
| `pos-wordnet-sense-embedding` | 0.5357 | 0.4643 | 0.7022 | 0.8644 |

CER@3 is 1.0 for all because entries have long candidate lists with multiple
clearly wrong definitions. Do not use it to distinguish models here.

`results/reader-dev-v1-pos-order-top-errors.csv` contains the seven POS-order
top-1 errors. They are same-POS issues: company (twice), subject (twice), rule,
model, letter.

`local_cache_mb` in evaluator output includes downloaded optional ONNX/OpenVINO
artifacts, not browser package size. Current values: E5 803.2 MB, WordNet sense
embedding 532.8 MB. Browser deployment claims have not been measured.

## Next work, in order

1. Run `prepare_coarsewsd.py` output through the evaluator and report the
   dataset separately. Never interpret unmapped labels as product glosses.
2. Add a `Babelscape/wsl-retriever-e5-base-v2` adapter. Inspect its documented
   query/document template and whether it can score the evaluator's candidate
   glosses directly. Evaluate raw and POS-first. It is CC-BY-NC-SA-4.0: research
   comparison only, not a production option without separate license review.
3. Add one or two small generic comparison encoders (MiniLM/BGE class) only if
   their license and model card permit it. Test raw and POS-first.
4. Test a small fixed matrix of context/gloss templates. Make choices from
   development data, then stop changing them before building reader test data.
5. Build/freeze a larger `reader-test-v1` from runtime entries with independent
   human review. Use it for final selection.
6. Phase 2 only after quality candidates emerge: ONNX export/quantization and
   real browser measurements (download, cold load, p50/p95, memory).

Do not prioritize PyMUSAS as a direct ranker: it predicts a semantic-tag
inventory rather than scores arbitrary candidate dictionary glosses. Classical
BEM remains a methodological reference but should follow WSL because its old
implementation requires more integration work.

## Useful commands

From `wsd\`:

```powershell
uv run python scripts/validate_reader_data.py
uv run python scripts/evaluate.py --dataset reader-dev-v1 --model pos-order pos-e5-small pos-wordnet-sense-embedding
uv run python scripts/evaluate.py --dataset raganato-all --model mfs e5-small wordnet-sense-embedding
uv run python scripts/report_top_errors.py --dataset reader-dev-v1 --model pos-order
```

Read `README.md` before changing the data pipeline. Dataset/model downloads and
outputs stay ignored; do not add large raw artifacts or model weights to Git.
