# Definition-ranking results — 2026-09-04

## Scope

`reader-dev-v2` is LLM-assisted development/evaluation data, not an unbiased
test set. All selected runtime definitions remain present. The 108 evaluated
occurrences contain 1,371 definitions from 57 source lemmas; 88 occurrences
form the same-POS hard slice. Another 12 draft occurrences with demonstrably
wrong product POS are documented and excluded.

## Reader results

| Model | Full CER@1 | Same-POS CER@1 | Same-POS pairwise | Full Top2Acceptable | Full MRR |
| --- | ---: | ---: | ---: | ---: | ---: |
| Dictionary order | 38/108 (35.19%) | 31/88 (35.23%) | 873/1,115 (78.30%) | 77/108 (71.30%) | 0.7285 |
| POS + dictionary order | **21/108 (19.44%)** | **21/88 (23.86%)** | 873/1,115 (78.30%) | 90/108 (83.33%) | **0.8510** |
| POS + lexical overlap | 67/108 (62.04%) | 67/88 (76.14%) | 541/1,115 (48.52%) | 65/108 (60.19%) | 0.5761 |
| POS + E5-small | 48/108 (44.44%) | 48/88 (54.55%) | 688/1,115 (61.70%) | 72/108 (66.67%) | 0.6781 |
| POS + E5-small, definition only | 40/108 (37.04%) | 40/88 (45.45%) | 882/1,115 (79.10%) | 90/108 (83.33%) | 0.7675 |
| POS + WordNet sense embedding | 59/108 (54.63%) | 59/88 (67.05%) | 838/1,115 (75.16%) | 76/108 (70.37%) | 0.6510 |
| POS + MiniLM | 49/108 (45.37%) | 49/88 (55.68%) | 751/1,115 (67.35%) | 77/108 (71.30%) | 0.6983 |
| POS + WSL retriever | 43/108 (39.81%) | 43/88 (48.86%) | 916/1,115 (82.15%) | 89/108 (82.41%) | 0.7571 |
| POS + E5/dictionary RRF | 44/108 (40.74%) | 44/88 (50.00%) | 793/1,115 (71.12%) | 79/108 (73.15%) | 0.7220 |
| POS + WSL/dictionary RRF | 33/108 (30.56%) | 33/88 (37.50%) | **942/1,115 (84.48%)** | **93/108 (86.11%)** | 0.8165 |

POS + dictionary order remains the safest Top-1 system. WSL is the only tested
semantic encoder that beats dictionary order on same-POS pairwise accuracy.
Reciprocal-rank fusion improves WSL from 43 to 33 full-slice catastrophic
errors and from 82.15% to 84.48% same-POS pairwise accuracy, but it still causes
12 more catastrophic errors than POS + dictionary order.

## Fixed gloss-format ablation

Removing `lemma + POS` from the E5 passage and embedding only the definition
improves full CER from 48/108 to 40/108 and same-POS pairwise accuracy from
61.70% to 79.10%. The likely explanation is that repeating the same lemma/POS
in every candidate adds shared signal without helping sense discrimination.
This was a single planned ablation, not a prompt sweep. It still does not beat
POS + dictionary order on Top-1 safety.

## CoarseWSD-20 diagnostic

| Model | Top-1 | MRR | WordNet mapping coverage |
| --- | ---: | ---: | ---: |
| Dictionary order | 7,487/10,196 (73.43%) | 0.8584 | 8,002/10,196 (78.48%) |
| E5-small | 8,353/10,196 (81.92%) | 0.9006 | 8,002/10,196 (78.48%) |
| WordNet sense embedding | 9,540/10,196 (93.57%) | 0.9646 | 8,002/10,196 (78.48%) |

This diagnostic is not combined numerically with reader data. Unmapped labels
are reported as mapping coverage, not product-ranking failures.

## Existing Raganato ALL sanity check

| Model | Exact Top-1 | MRR |
| --- | ---: | ---: |
| MFS | 52.86% | 0.7054 |
| E5-small | 31.40% | 0.5359 |
| WordNet sense embedding | 45.03% | 0.6453 |

## Engineering size notes

| Model | Parameters | Primary FP32 weight | License | Type | Published ONNX | Browser outlook |
| --- | ---: | ---: | --- | --- | --- | --- |
| E5-small-v2 | 33.4M | 133.5 MB | MIT | generic retrieval | yes | plausible after quantization |
| all-MiniLM-L6-v2 | 22.7M | 90.9 MB | Apache-2.0 | generic embedding | yes | good size, insufficient quality here |
| WordNet sense embedding | 132.7M | 530.9 MB | Apache-2.0 | WSD-specific | no known official export | poor |
| WSL retriever E5-base-v2 | 109.5M | 438.0 MB | CC-BY-NC-SA-4.0 | WSD-specific | no known official export | research-only and too large |

These are checkpoint weight sizes, not browser download measurements. Local
cache totals are larger because repositories include duplicate formats and
optional exports.

## Decision

1. Specialized WSL materially beats compact encoders on same-POS pairwise
   discrimination, but not on Top-1 reliability.
2. Dictionary-order fusion helps WSL substantially, without making it safer
   than POS + dictionary order.
3. Definition-only E5 is the strongest compact generic formulation tested, but
   the overall gain remains modest: 78.30% dictionary-order pairwise rises to
   84.48% for the best hybrid, while catastrophic Top-1 reliability worsens.
4. No tested small model should proceed to browser/ONNX integration yet.

Machine-readable results are in `results/reader-dev-v2-benchmark.csv` and
`results/coarsewsd-20-test-benchmark.csv`. Candidate-level failure and margin
reports are in the corresponding `results/reader-dev-v2-*` CSV files.
