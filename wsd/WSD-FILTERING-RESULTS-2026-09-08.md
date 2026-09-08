# Contextual definition-filtering results — 2026-09-08

## Decision

Do not ship a hard three-definition filter from the tested models. The best
fixed-Top-3 result is E5 definition-only fused 50/50 with dictionary order. It
removed every acceptable definition in 3/31 held-out occurrences (9.68%,
Wilson 95% CI 3.35–24.90%) and in 9/49 occurrences on the older hard-word
stress set. This is far above a conservative launch standard.

A safety-first split-conformal policy around that same ranker had zero observed
unsafe exclusions on both evaluation slices, but averaged 8.61 and 8.92
definitions. This is the best current removal algorithm if more than three
definitions are allowed when the model is uncertain; it is not a solution to a
hard three-definition requirement.

Keep a maximum of three as the benchmark target. The calibrated adaptive
policies could not reliably show fewer definitions without increasing risk;
the original capped margin candidate averaged 2.97 definitions on held-out
data but retained five unsafe exclusions. The later uncapped conformal policy
improved safety by explicitly allowing larger candidate sets.

## Benchmark design

`reader-filter-dev-v1` complements rather than replaces the deliberately hard
`reader-dev-v2` ranking set. Its builder considers every eligible occurrence in
the two bundled books, then samples deterministically before any model score is
computed.

- Uses the deployed exact-form-first lookup, lemmatization, contextual POS, and
  lexicon data.
- Selects ordinary nouns, verbs, adjectives, and adverbs with 6–30 definitions
  in the POS group currently visible to the reader.
- Excludes source occurrences already present in `reader-dev-v2`, removes
  duplicate lemma/context pairs, and caps each lemma at five occurrences.
- Retains every definition from the selected lexicon entry; filtering happens
  only inside the runtime-visible POS group.
- Splits by a stable lemma hash, so no lemma occurs in both calibration and
  evaluation.

The builder found 17,855 eligible occurrences and sampled a 100-occurrence
draft. Ten POS, compound-tokenization, or dictionary-coverage failures are
documented rather than assigned fabricated gold definitions. The final set has
90 occurrences from 74 lemmas:

| Property | Value |
| --- | ---: |
| Calibration / held-out evaluation | 59 / 31 |
| Alice / Hitchhiker's Guide | 31 / 59 |
| Noun / verb / adjective / adverb | 35 / 28 / 19 / 8 |
| Runtime-visible definitions | 1,202 |
| Definitions per occurrence | 6–30, mean 13.36, median 13 |
| Annotation confidence | 79 high, 11 medium |

Annotations were made before model scoring. Each definition is `fits`,
`plausible`, or `clearly_wrong`; both of the first two are treated as acceptable
to make suppression conservative. A stability pass reread all initially
medium-confidence examples, the union of fixed-Top-3 failures from dictionary
order and the two fusion candidates, and a deterministic ten-example
high-confidence sample. No labels were changed to agree with a model; three
newly discovered invalid examples were excluded. The annotations are still
provisional and are not a substitute for independent human review.

The primary failure is **unsafe exclusion**: none of an occurrence's acceptable
definitions survives. `all_fits_hidden` is a stricter secondary signal that
ignores merely plausible alternatives. A conservative screening gate requires
zero unsafe exclusions on held-out data and no regression on the older crowded
stress slice. No model passed.

## Held-out results

All rows show exactly the best three definitions. The dictionary-order row is
the zero-model baseline. RRF combines semantic rank with the lexicon's original
order.

| Model | Unsafe | 95% CI | All `fits` hidden | Acceptable recall | Wrong suppressed |
| --- | ---: | ---: | ---: | ---: | ---: |
| Dictionary order | 7/31 (22.58%) | 11.40–39.81% | 12/31 | 64.71% | 81.65% |
| Lexical overlap | 17/31 (54.84%) | 37.77–70.84% | 20/31 | 41.18% | 77.98% |
| E5-small | 11/31 (35.48%) | 21.12–53.05% | 14/31 | 45.10% | 78.59% |
| E5-small, definition only | 8/31 (25.81%) | 13.70–43.25% | 11/31 | 58.82% | 80.73% |
| all-MiniLM-L6-v2 | 13/31 (41.94%) | 26.42–59.23% | 16/31 | 43.14% | 78.29% |
| Arctic Embed XS | 9/31 (29.03%) | 16.10–46.59% | 10/31 | 58.82% | 80.73% |
| TinyBERT-L2 cross-encoder | 13/31 (41.94%) | 26.42–59.23% | 18/31 | 39.22% | 77.68% |
| MiniLM-L2 cross-encoder | 13/31 (41.94%) | 26.42–59.23% | 18/31 | 41.18% | 77.98% |
| E5 definition-only + 50/50 RRF | **3/31 (9.68%)** | 3.35–24.90% | 8/31 | **72.55%** | **82.87%** |
| Arctic XS + 25/75 RRF | 5/31 (16.13%) | 7.09–32.63% | 9/31 | 70.59% | 82.57% |

The favorable E5 fusion row is exploratory, not the selected result. On the
calibration split it had 19 unsafe failures, compared with 18 for dictionary
order. The dictionary-heavy Arctic fusion was frozen instead because it was the
only tested compact hybrid to improve calibration safety: 17/59 versus 18/59.
It then improved the held-out count from seven to five, but not nearly enough
to pass the absolute safety gate. The one-example calibration difference is
also too small to establish a stable advantage.

Fixed Top 1 and Top 2 made the risk worse. For the selected Arctic fusion,
unsafe failures were 10/31 at Top 1, 7/31 at Top 2, and 5/31 at Top 3. Its
calibrated margin rule retained the same five failures and showed two rather
than three definitions only once. The E5 fusion's margin rule averaged 2.84,
but its threshold came from a calibration result that did not beat the baseline.

## Older hard-word stress set

The crowded slice of `reader-dev-v2` contains 49 occurrences with more than
five runtime definitions. Fixed Top 3 produced:

| Model | Unsafe | 95% CI | Acceptable recall |
| --- | ---: | ---: | ---: |
| Dictionary order | 13/49 (26.53%) | 16.21–40.26% | 56.47% |
| E5 definition-only + 50/50 RRF | **9/49 (18.37%)** | 9.98–31.36% | **63.53%** |
| Arctic XS + 25/75 RRF | 16/49 (32.65%) | 21.21–46.62% | 52.94% |

This stress result reinforces the no-launch decision for the calibration-picked
Arctic candidate. It also makes E5 fusion worth retaining for future research,
but does not justify selecting it after observing the held-out outcomes.

## Serverless engineering comparison

Quality was measured with local FP32 PyTorch checkpoints. Published quantized
ONNX sizes indicate browser feasibility but were not run in a browser and may
not preserve the same accuracy. CPU figures are batch throughput on this
development machine, not click latency.

| Model | Parameters | Local FP32 cache | Published qint8 ONNX | License | CPU examples/s |
| --- | ---: | ---: | ---: | --- | ---: |
| E5-small-v2 | 33.4M | 134.5 MB | 34.1 MB | MIT | 62 |
| all-MiniLM-L6-v2 | 22.7M | 91.6 MB | 23.0 MB | Apache-2.0 | 127 |
| Arctic Embed XS | 22.6M | 91.3 MB | 23.0 MB | Apache-2.0 | 114 |
| TinyBERT-L2 cross-encoder | 4.39M | 18.5 MB | 4.52 MB | Apache-2.0 | 125 |
| MiniLM-L2 cross-encoder | — | 63.4 MB | 15.8 MB | Apache-2.0 | 33 |

Bi-encoder throughput times one context embedding per occurrence; definition
embeddings are prepared with the lexicon and excluded from online timing.
Cross-encoder timing includes all context/definition pairs and therefore grows
with the exact crowding this feature must address. The tiny cross-encoder is
attractive in download size but clearly fails the quality screen.

The existing 530.9 MB WordNet sense encoder and 438.0 MB WSL retriever were not
rerun: they already fail the serverless size criterion, and WSL is additionally
CC-BY-NC-SA-4.0. Their earlier ranking results remain in
`WSD-RESULTS-2026-09-04.md` as research references.

## Recommendation

1. Do not integrate a model into the reader yet.
2. Treat POS filtering followed by E5 definition-only/dictionary RRF as the
   current ranking baseline. If safety dominates card length, wrap it in the
   5% split-conformal margin policy and permit more than three results.
3. Do not use fixed Top 4 as a shortcut. It happened to reach zero failures on
   the 31-example held-out slice but still failed 5/49 older stress examples.
4. Add more books and contemporary prose, double-annotate disagreements, and
   keep lemmas author-disjoint where possible before training or tuning further.
5. Train or distill a sense-specific compact bi-encoder against exact deployed
   lexicon glosses. Generic retrieval and MS MARCO cross-encoders are not
   reliable enough for destructive filtering. The Wiktionary usage-example
   extractor added in the continuation is a viable product-native data source,
   but its labels need stronger alignment and validation.

## Continuation experiments

### Safety-aware candidate sets

The original margin policy could only remove definitions from an already
truncated Top 3. The continuation added a split-conformal threshold over the
best acceptable candidate's score margin. This lets the model return more than
three definitions when calibration evidence says the Top 3 is unsafe.

| Slice | Policy | Unsafe | Acceptable recall | Mean / max shown | Wrong suppressed |
| --- | --- | ---: | ---: | ---: | ---: |
| New held-out | E5 RRF Top 3 | 3/31 | 72.55% | 3.00 / 3 | 82.87% |
| New held-out | E5 RRF Top 4 | **0/31** | 90.20% | 4.00 / 4 | 76.00% |
| New held-out | E5 RRF conformal 5% | **0/31** | **100.00%** | 8.61 / 16 | 33.94% |
| Older crowded stress | E5 RRF Top 3 | 9/49 | 63.53% | 3.00 / 3 | 83.09% |
| Older crowded stress | E5 RRF Top 4 | 5/49 | 75.29% | 4.00 / 4 | 76.00% |
| Older crowded stress | E5 RRF conformal 5% | **0/49** | 96.47% | 8.92 / 17 | 35.45% |

The conformal observation is encouraging but exploratory. Its marginal
coverage guarantee requires exchangeable calibration and deployment examples;
these two small, Codex-annotated book samples do not establish that condition.
The zero observed count must not be presented as a zero production error rate.

A separate abstention rule that showed Top 3 only above a calibrated confidence
threshold was safe but nearly useless: only 1/31 held-out cards qualified, and
the remaining cards retained their full POS group.

### Additional rankers and product-native training

- A three-slot coverage ensemble across dictionary, E5, and Arctic rankings
  selected on calibration still failed 6/31 held-out cards.
- A small linear selector over dictionary, lexical, E5, and Arctic features
  selected with lemma-grouped cross-validation failed 5/31 and required both
  neural models.
- A six-layer MS MARCO MiniLM cross-encoder (22.7M parameters, 91.8 MB FP32)
  failed 12/31 at Top 3 and ran at roughly 12 cards/s on the development CPU.
- The raw Wiktionary extraction contains per-sense usage examples. A
  deterministic extractor produced 20,000 training contexts while excluding
  every lemma in both reader benchmarks. It can only construct negatives from
  senses with extractable examples, so its candidate inventory is an
  approximation of the deployed flattened lexicon rather than an exact match.
- Fine-tuning the 4.39M-parameter TinyBERT cross-encoder on 10,000 extracted
  contexts improved its held-out Top-3 unsafe count only from 13/31 to 12/31.
  A listwise same-word objective also produced 12/31. TinyBERT is therefore too
  weak even though its approximately 4.5 MB quantized size is attractive.

### E5 query ablation

Five context-query formats were compared while keeping definition-only passages
and 50/50 dictionary fusion fixed. A natural question prompt reduced calibration
failures from 19/59 to 13/59, but increased held-out failures from 3/31 to 7/31.
The reversal is evidence of sample instability, so the original E5 formulation
remains the baseline and no more prompt tuning should use this held-out split.

The next model-training experiment should follow the gloss-informed bi-encoder
formulation rather than independent binary relevance training. This matches the
architecture supported by [Blevins and Zettlemoyer (ACL 2020)](https://aclanthology.org/2020.acl-main.95/).
Recent general-domain results also support sense-balanced LLM-labelled data for
training compact disambiguators; see [Ming et al. (EMNLP 2025)](https://aclanthology.org/2025.emnlp-main.45/).

Machine-readable outputs are generated at
`results/reader-filter-dev-v1-filtering.csv` and
`results/reader-dev-v2-filtering.csv`. Continuation diagnostics add
`reader-filter-dev-v1-e5-prompt-search.csv`,
`reader-filter-dev-v1-ensemble-search.csv`,
`reader-filter-dev-v1-learned-filter-search.csv`,
`reader-filter-dev-v1-selective-filter.csv`, and the transfer-filtering CSV.
