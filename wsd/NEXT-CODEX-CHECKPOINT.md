# Assisted Reader WSD checkpoint — 2026-09-04

## Product invariant

Never suppress definitions. Ranking may reorder every definition the deployed
lexicon would display. Production reader changes in this session are limited to
conservative contextual POS inference; no semantic model was integrated and no
UI behavior was changed.

## Dataset state

- `reader-dev-v2-draft.jsonl`: 120 occurrences from 57 lemmas, built through
  the real `src/core/nlp.ts` pipeline with exact-form-first lexicon lookup.
- `reader-dev-v2.jsonl`: 108 valid evaluated occurrences and 1,371 candidates.
- Same-POS slice: 88 occurrences; 80 of 108 evaluated examples (74.1%) have at
  least two matching-POS candidates.
- Excluded: 12 documented product-POS failures. They remain in the draft and
  `reader-dev-v2-exclusions.json`; they were not given fabricated gold labels.
- Annotation: 14 v1 occurrences transferred, 20 valid one-matching-POS cases
  seeded deterministically, and 74 contextual occurrences provisionally
  annotated by Codex. Confidence is 107 high / 1 low.
- Stability review: the low-confidence occurrence, all 21 POS-order Top-1
  errors, and a seeded 10-example random sample were reread without semantic
  model rankings; no labels changed.

This is development/evaluation data, not an independent or unbiased test set.

## Implemented changes

- Metrics: raw counts, Top2Acceptable, same-POS hard slice,
  PairwiseSamePOS, and acceptable-vs-wrong raw score margins.
- Reports: candidate-level raw/final scores, POS, relevance, original rank,
  definitions, catastrophic errors, and worst same-POS margins.
- Rankers: zero-model lexical overlap, MiniLM, WSL retriever, and fixed
  reciprocal-rank fusion with dictionary order.
- WSL format was checked against official source: `question: <context>` and
  `passage: <lemma>: <definition>`. License is CC-BY-NC-SA-4.0; research only.
- CoarseWSD-20 was evaluated separately with mapping coverage.

### Production POS-awareness patch

- `src/core/nlp.ts` no longer chooses between incompatible open-class tags by
  fixed priority. It returns unknown POS so definition lookup preserves every
  available POS group.
- Added conservative rules for possessive pronouns, a small high-confidence
  superlative set, `bound to`, coordinated/list nouns, gerund-object nouns, and
  labeled points.
- Structurally ambiguous noun-tagged copular complements return unknown POS.
  Thus `Are you content?` exposes all groups rather than confidently choosing
  noun without enough lexical evidence.
- The patch covers 11 of the 12 original excluded failures: 10 now receive the
  intended exact POS and `content` safely falls back to unknown. Imperative
  `tie 'em together` remains for a possible clause-boundary-aware follow-up.
- Regression tests include all 11 in-scope cases plus nearby false-positive
  controls (`mine` as a verb, `presents` as a verb, `charge` as a verb, and
  `forest` as a noun modifier).
- Validation passed: application TypeScript check and all 46 compiled tests.
- `site_algorithms.md` documents the new behavior.

The benchmark results below predate this production patch. The 12 failures stay
documented in the draft/exclusion manifest; the annotated 108-example WSD set
was not silently regenerated or relabeled.

## Main reader-dev-v2 results

| Model | Full CER@1 | Same-POS CER@1 | Same-POS pairwise | Full Top2 | Full MRR |
| --- | ---: | ---: | ---: | ---: | ---: |
| dictionary order | 38/108 (35.19%) | 31/88 (35.23%) | 873/1,115 (78.30%) | 71.30% | 0.7285 |
| POS order | **21/108 (19.44%)** | **21/88 (23.86%)** | 873/1,115 (78.30%) | 83.33% | **0.8510** |
| POS + lexical | 67/108 (62.04%) | 67/88 (76.14%) | 541/1,115 (48.52%) | 60.19% | 0.5761 |
| POS + E5-small | 48/108 (44.44%) | 48/88 (54.55%) | 688/1,115 (61.70%) | 66.67% | 0.6781 |
| POS + E5 definition-only | 40/108 (37.04%) | 40/88 (45.45%) | 882/1,115 (79.10%) | 83.33% | 0.7675 |
| POS + WN sense embedding | 59/108 (54.63%) | 59/88 (67.05%) | 838/1,115 (75.16%) | 70.37% | 0.6510 |
| POS + MiniLM | 49/108 (45.37%) | 49/88 (55.68%) | 751/1,115 (67.35%) | 71.30% | 0.6983 |
| POS + WSL | 43/108 (39.81%) | 43/88 (48.86%) | 916/1,115 (82.15%) | 82.41% | 0.7571 |
| POS + E5/dictionary RRF | 44/108 (40.74%) | 44/88 (50.00%) | 793/1,115 (71.12%) | 73.15% | 0.7220 |
| POS + WSL/dictionary RRF | 33/108 (30.56%) | 33/88 (37.50%) | **942/1,115 (84.48%)** | **86.11%** | 0.8165 |

Conclusion: WSL has the best semantic discrimination and dictionary fusion
helps it, but POS + dictionary order remains substantially safer at Top-1. No
small model is ready for Phase 2 browser integration.

One fixed E5 gloss ablation was run. Definition-only passages substantially
beat `lemma + POS + definition` (79.10% versus 61.70% same-POS pairwise), but
still produce 40 versus POS-order's 21 full-slice catastrophic errors.

## Separate diagnostics

CoarseWSD-20 (10,196 examples, mapping 8,002/10,196): dictionary 73.43%
Top-1 / 0.8584 MRR; E5-small 81.92% / 0.9006; WordNet sense embedding
93.57% / 0.9646.

Existing Raganato ALL: MFS 52.86% / 0.7054; E5-small 31.40% / 0.5359;
WordNet sense embedding 45.03% / 0.6453.

## Reproduction

From the repository root:

```powershell
node wsd/scripts/run-ts-script.mjs wsd/scripts/build-reader-dev-v2.mts
uv run --project wsd python wsd/scripts/seed_reader_dev_v2_review.py
uv run --project wsd python wsd/scripts/apply_provisional_labels_v2.py
uv run --project wsd python wsd/scripts/apply_reader_review.py --dataset reader-dev-v2
uv run --project wsd python wsd/scripts/validate_reader_data.py --dataset reader-dev-v2
uv run --project wsd python wsd/scripts/evaluate.py --dataset reader-dev-v2 --model mfs pos-order pos-lexical-overlap e5-small pos-e5-small pos-e5-small-definition-only wordnet-sense-embedding pos-wordnet-sense-embedding minilm pos-minilm wsl-retriever pos-wsl-retriever pos-e5-small-rrf pos-wsl-retriever-rrf
uv run --project wsd python wsd/scripts/evaluate.py --dataset coarsewsd-20-test --model mfs e5-small wordnet-sense-embedding
```

Model weights and external benchmark corpora stay ignored. Exact tables and
engineering notes are in `WSD-RESULTS-2026-09-04.md`.

## Next questions

1. Investigate why semantic models lose Top-1 despite respectable pairwise
   accuracy; error reports suggest extreme outliers and morphology-only glosses.
2. Consider a conservative semantic override that changes dictionary order only
   above a large margin, evaluated without a broad parameter search.
3. Optionally implement clause-boundary-aware imperative recognition for the
   remaining `tie 'em together` failure.
4. Measure the new POS behavior on a fresh diagnostic sample. Do not use the
   ambiguity-heavy 120-example draft to estimate real-world POS error prevalence.
5. Do not begin browser integration unless a future method beats POS order on
   catastrophic errors, not merely pairwise accuracy.

## Human-readable session report

Open `PROGRESS-2026-09-04.html` for the complete plain-language summary of the
research results, practical decisions, POS patch, validation, and next steps.
