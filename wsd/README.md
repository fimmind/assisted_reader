# WSD / gloss-ranking benchmark

This directory evaluates definition ranking, not definition suppression. Every
candidate gloss stays in the ranking. The current product development dataset
is `data/processed/reader-dev-v2.jsonl`, annotated with `fits`, `plausible`, or
`clearly_wrong` relevance labels. It is LLM-assisted development/evaluation
data, not an unbiased test set.

## Phase 1

1. Create an isolated environment: `uv sync`
2. Download data and WordNet: `uv run python scripts/download_data.py`
3. Download models: `uv run python scripts/download_models.py e5-small wordnet-sense-embedding`
4. Convert Raganato ALL: `uv run python scripts/prepare_raganato.py --dataset ALL`
4. Run baselines: `uv run python scripts/evaluate.py --dataset raganato-all --model mfs pos-mfs`
6. Run encoders: `uv run python scripts/evaluate.py --dataset raganato-all --model e5-small wordnet-sense-embedding`

The first model comparison targets the Raganato `ALL` aggregate as an academic
sanity check. It must not be used to choose the production model by itself.
Once `reader-dev-v1.jsonl` is annotated, the same command reports product
ranking metrics, including catastrophic-error rate and pairwise
acceptable-vs-clearly-wrong accuracy.

Reader evaluations emit separate `full` and `same-pos` rows. Reports include
raw counts, Top2Acceptable, same-POS pairwise accuracy, and the mean
best-acceptable minus best-wrong pre-POS score margin.

`pos-order` and the `pos-*` encoder variants are ranking ablations, not
definition filters: they retain every definition but place an inferred matching
part of speech ahead of other POS groups. They quantify how much value the
existing POS inference adds before semantic disambiguation.

Use `--limit N` only as an installation smoke test. It selects the first `N`
examples and is not a representative model comparison.

`local_cache_mb` is the local downloaded snapshot, including optional ONNX and
OpenVINO artifacts. It is not a browser-download claim; browser package and
quantization measurements belong to Phase 2.

## Data provenance

`download_data.py` fetches the Raganato Unified WSD framework and CoarseWSD-20
from their public canonical project archives. It does not commit downloaded
datasets or model weights. CoarseWSD-20 is preserved for its coarse-label
diagnostic. `prepare_coarsewsd.py` records its WordNet mapping coverage; labels
without a WordNet mapping are never treated as a production glossary result.

## Reader-dev schema

```json
{"id":"reader-001","dataset":"reader-dev-v1","context":"He sat on the bank and watched the river.","target":"bank","lemma":"bank","pos":"noun","candidates":[{"sense_id":"bank-1","gloss":"A financial institution.","relevance":"clearly_wrong"},{"sense_id":"bank-2","gloss":"Land alongside a river.","relevance":"fits"}]}
```

Candidates must be copied from the definitions displayed by Assisted Reader for
that occurrence, without dropping alternatives. `scripts/validate_reader_data.py`
checks this file before it is evaluated.

## Creating the initial reader dataset

`uv run python scripts/build_reader_dev_draft.py` fetches only the deployed
lexicon buckets for a curated ambiguous-lemma list and creates up to 100
examples from the bundled books. It selects short contexts and entries with 3-20
definitions so the first review pass is practical; every definition for a
selected entry remains present. It deliberately labels every definition
`needs_review`; `uv run python scripts/review-reader-dev-draft.py` turns it into a
one-row-per-definition CSV for annotation. Reviewers should replace that value
with `fits`, `plausible`, or `clearly_wrong`, then export the reviewed records
by running `uv run python scripts/apply_reader_review.py`. This creates
`data/processed/reader-dev-v1.jsonl`, which must pass
`uv run python scripts/validate_reader_data.py` before evaluation.

## Creating reader-dev-v2

Install the repository's locked Node dependencies from the repository root,
then run:

```powershell
node wsd/scripts/run-ts-script.mjs wsd/scripts/build-reader-dev-v2.mts
uv run --project wsd python wsd/scripts/seed_reader_dev_v2_review.py
uv run --project wsd python wsd/scripts/apply_provisional_labels_v2.py
uv run --project wsd python wsd/scripts/apply_reader_review.py --dataset reader-dev-v2
uv run --project wsd python wsd/scripts/validate_reader_data.py --dataset reader-dev-v2
```

The builder imports `src/core/nlp.ts`, including deployed Compromise tagging,
contextual POS corrections, and deinflection. It uses exact displayed-word
lookup before lemma fallback, permits five occurrences per lemma, stores stable
source-location IDs and original dictionary ranks, and retains every definition
for each selected entry. Selection caps complete entries at 30 definitions to
prevent a few huge entries from dominating review.

The draft has 120 occurrences. Twelve documented product-POS failures in
`data/reader-dev-v2-exclusions.json` remain inspectable but are excluded from
the 108-example evaluation rather than receiving fabricated labels.
`data/reader-dev-v2-stability-review.json` records the second review pass.

`wsl-retriever` is a research reference only: it is CC-BY-NC-SA-4.0 and is not
a production candidate without a separate license review. The adapter follows
the official implementation's `question:` context and `passage:` sense-document
prefixes.

The single gloss-format ablation is named
`pos-e5-small-definition-only`. Use `evaluate.py --append` for a focused run
that should merge into, rather than replace, an existing benchmark CSV.
