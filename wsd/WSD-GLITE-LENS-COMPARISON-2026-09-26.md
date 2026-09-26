# Glite LENS versus Ettin and SayedShaun for WordNet definition filtering

The [Glite LENS paper](https://arxiv.org/abs/2609.17554) releases a 298M-parameter ModernBERT bi-encoder trained on relabeled SemCor. On this repository's 5,523 held-out Raganato occurrences, its seed-42 checkpoint ranks gold senses better than Ettin and SayedShaun. Its conservative 1% calibrated filter also removes more non-gold definitions than Ettin at nearly the same gold-sense miss count. At looser calibration targets its gold misses rise quickly. No tested setting removes definitions without sometimes excluding the gold sense.

## Method and validation

- Used the canonical `lens-gpt55-s42` checkpoint, whose released Git LFS SHA-256 is `4654117eefbdef5305461ba2d0fc7e7a4087718991f935fca2ae8cf5f64a102a`. The [model card](https://github.com/GliteTech/research-semcor-relabeling/blob/main/tasks/t0034_glite_lens_canonical/assets/model/glite-lens-canonical-modernbert-v1/description.md) specifies separate ModernBERT-base context and gloss towers, target-subword mean pooling, structured glosses, and dot-product scores. The adapter uses the packaged tokenizer, five preceding plus one following sentence within each source document, 324-token target-centered context truncation, and 512-token gloss truncation.
- Used the same WordNet candidate inventory and gold labels as the existing Ettin and SayedShaun comparison: 429 SemEval-2007 calibration occurrences and 5,523 held-out occurrences in Senseval-2, Senseval-3, SemEval-2013, and SemEval-2015. No gold sense was inserted into the options. The paper's released inventory matches this repository's on 5,494 of the 5,523 held-out cases; this repository has additional candidates on 29 cases. LENS was scored on those additional candidates too, preserving the comparison with Ettin.
- The reconstructed context text and target offsets match the [released predictions](https://github.com/GliteTech/research-semcor-relabeling) on all 5,523 cases. Local Top 1 predictions agree with that release on 5,512 cases, including 5,491 of 5,494 cases with identical candidate inventories. The released Top 1 accuracy on this subset is 80.17%; the local score is 80.01%. The 11 differences include eight cases with additional local candidates.
- Each margin threshold was chosen using only the 429 calibration cases. A `0%` target means an infinite margin that shows every definition. `Gold excluded` means no annotated gold synset remains. `Non-gold removed` is the fraction of non-gold synsets hidden; `precision` is exact gold synsets divided by displayed synsets. A non-gold synset is only a proxy for an unacceptable reader definition, and the paper itself documents noise in fine-grained gold labels.

## Ranking on 5,523 held-out occurrences

| Model | Top 1 gold accuracy | Top 3 gold excluded | Top 3 non-gold removed |
| --- | ---: | ---: | ---: |
| Ettin 150M WSD | 76.63% | 205 | 68.45% |
| SayedShaun WSD | 71.59% | 327 | 68.02% |
| Glite LENS | 80.01% | 145 | 68.68% |

The paired Top 3 comparison has 150 cases where LENS retains gold and Ettin does not, versus 90 in the opposite direction (two-sided exact paired sign test, `p = 0.00013`). LENS's higher Top 1 accuracy does not by itself establish a safe removal threshold.

## Calibration targets from 0% to 5%

Each cell below is `gold excluded / 5,523; non-gold removed`. The target is the nominal calibration miss rate, not a guaranteed held-out rate.

| Target | Ettin | SayedShaun | Glite LENS |
| --- | ---: | ---: | ---: |
| 0% | 0; 0% | 0; 0% | 0; 0% |
| 1% | 45 (0.81%); 44.71% | 28 (0.51%); 28.22% | 44 (0.80%); 59.89% |
| 2% | 122 (2.21%); 67.92% | 129 (2.34%); 55.16% | 144 (2.61%); 75.79% |
| 3% | 162 (2.93%); 72.05% | 167 (3.02%); 61.38% | 175 (3.17%); 78.41% |
| 4% | 192 (3.48%); 75.64% | 229 (4.15%); 67.67% | 272 (4.92%); 84.74% |
| 5% | 211 (3.82%); 77.47% | 253 (4.58%); 68.99% | 353 (6.39%); 87.59% |

At the 1% calibration target, LENS excludes gold on one fewer occurrence than Ettin while removing 15.19 percentage points more non-gold synsets. Their paired gold-retention disagreements are almost balanced: 34 favor LENS and 33 favor Ettin. At the 5% target, LENS removes 10.12 points more non-gold synsets but excludes gold on 142 more occurrences; 264 paired cases favor Ettin's gold retention and 122 favor LENS (`p = 3.9e-13`). The observed 6.39% LENS miss rate also exceeds its nominal 5% target.

The retained-definition precision at the 1% setting is 31.42% for LENS, 24.95% for Ettin, and 20.44% for SayedShaun. At the 5% setting it is 57.71%, 43.75%, and 35.92%, respectively; that higher precision comes with the gold exclusions shown above.

## CPU speed with gloss vectors prepared

Full-set throughput uses 5,952 calibration-plus-test occurrences. All models used the same local CPU and installed PyTorch/Transformers versions with four PyTorch inference threads, `OMP_NUM_THREADS=1`, and `OPENBLAS_NUM_THREADS=1`. The Ettin and SayedShaun full-set times came from saved score checkpoints; the single-occurrence runs were repeated in this session for all three models.

| Measurement | Ettin | SayedShaun | Glite LENS |
| --- | ---: | ---: | ---: |
| Offline definition preparation, full Raganato inventory (41,319 candidate entries) | 0 s | 119.8 s (9,776 unique glosses) | 840.7 s (11,450 unique structured glosses) |
| Offline definition preparation, 39 reader cards (375 candidate entries) | 0 s | 3.16 s | 23.81 s |
| Warm seven-definition occurrence, online p50 / p95 | 99.0 / 120.8 ms | 18.6 / 20.2 ms | 51.0 / 55.6 ms |
| Seven-definition occurrence, one-time definition preparation | 0 ms | 48.6 ms | 373.5 ms |
| 39 short, crowded reader cards, online throughput | 1.20/s (32.60 s total) | 28.11/s (1.39 s total) | 17.01/s (2.29 s total) |
| Full Raganato online throughput, 5,952 occurrences | 7.61/s (782.09 s total) | 47.73/s (124.70 s total) | 5.46/s (1,090.86 s total) |
| Model startup, seven-definition measurement | 1.36 s | 0.78 s | 16.82 s |
| Peak process memory, seven-definition measurement | 1,353 MiB | 958 MiB | 2,773 MiB |

LENS saved a 34 MB embedding file for the full inventory. The seven-definition example has a 46-token LENS context; the full Raganato set has a median of 182 context tokens. This helps explain why LENS wins on the short interactive example but trails Ettin in full-set throughput. The reader-card throughput also reflects a different workload with many definitions per occurrence; its 39 cases are too few for a stable speed distribution. Online rows exclude definition preparation and model startup. Offline preparation is a one-time cost when embeddings are reused; it is material when candidate definitions change. Startup and peak memory are single-process measurements, not benchmark distributions.

## Reader-card pilot and decision

The WordNet reader-card pilot has 24 calibration and 15 held-out occurrences with provisional `fits`, `plausible`, and `clearly_wrong` labels. At the calibration-only 5% margin, LENS retains at least one acceptable definition on all 15, hides an acceptable definition on 2, and removes 87.5% of clearly wrong definitions. Ettin has corresponding counts of 0, 3, and 74.0%; SayedShaun has 0, 0, and 42.3%. At fixed Top 3, LENS and SayedShaun each hide all `fits` definitions in one occurrence, versus two for Ettin. The pilot is too small and provisional to establish a dependable safety rate.

LENS is the strongest tested ranker here and has the best observed conservative 1% removal trade-off against Ettin. It is worth further investigation for reader filtering, especially with more independently reviewed reader-card labels. It does not meet a literal zero-gold-loss requirement: even the 1% setting misses gold 44 times. The [released weights are CC BY-NC 4.0](https://github.com/GliteTech/research-semcor-relabeling#licensing), which also requires a separate license assessment before production use.

## Reproduction

```sh
cd wsd
uv run python scripts/download_glite_lens.py
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 uv run python scripts/evaluate_wordnet_filtering.py --model glite-lens
uv run python scripts/report_wordnet_filter_sweep.py --model ettin-150m-wsd sayedshaun-wsd glite-lens
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 uv run python scripts/evaluate_filtering.py --dataset reader-wordnet-filter-pilot --model glite-lens --max-definitions 3 --append
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 uv run python scripts/benchmark_interactive.py --dataset raganato-senseval2 --model glite-lens --example-index 7 --warmups 3 --repetitions 20
```

Generated full metrics, 0%-5% sweep, scores, and timings live under ignored `results/`. The corresponding exact source checkpoint and tokenizer are verified by `scripts/download_glite_lens.py` before use.
