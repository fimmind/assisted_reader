# SayedShaun WSD versus Ettin for WordNet definition filtering

The [SayedShaun checkpoint](https://huggingface.co/SayedShaun/word-sense-disambiguation) is a faster CPU ranker when WordNet gloss vectors are prepared in advance, but its filtering accuracy is below Ettin's on the full held-out benchmark. It is not a better replacement for Ettin when the goal is to remove wrong definitions while retaining the gold sense.

## Method

- Evaluated the cosine architecture checkpoint `cosine/step-12000-f1-0.8066.pt` at revision `54e41c09c61ae8bd60c62e40bf483141c49ce0d3`, with the base DistilBERT tokenizer/config at revision `12040accade4e8a0f71eabdb258fecc2e7e948be`. The adapter follows the [published model and dataset code](https://github.com/sayedshaun/wsd): `<classify>` target markers, 256-token truncation, unnormalized `[CLS]` vectors, and raw dot products. The checkpoint's `target_word` input is unused by its encoder.
- Used the same WordNet candidate sets as the existing Ettin benchmark: 429 SemEval-2007 occurrences for calibration and 5,523 held-out occurrences from Senseval-2, Senseval-3, SemEval-2013, and SemEval-2015. All available candidates were scored. No gold sense was inserted into the candidate list during evaluation.
- Fixed Top 1 and Top 3 retain the highest-scored definitions. The margin filter threshold was chosen separately for each model using only the 429 calibration occurrences, with nominal 1% or 5% gold-sense miss targets. The held-out cases did not influence either threshold.
- `gold excluded` counts an occurrence where none of its annotated gold synsets remains. `Non-gold suppressed` counts removed non-gold candidate synsets divided by all non-gold candidate synsets. `Retained precision` is the fraction of shown definitions that are exact gold synsets. These are academic proxies: a non-gold WordNet synset is not necessarily unacceptable to a reader.

## Held-out results

| Policy | Model | Gold excluded | Non-gold suppressed | Retained precision | Mean definitions shown |
| --- | --- | ---: | ---: | ---: | ---: |
| Top 1 | Ettin 150M WSD | 1,291 / 5,523 (23.37%) | 95.92% | 76.63% | 1.00 |
| Top 1 | SayedShaun WSD | 1,569 / 5,523 (28.41%) | 95.04% | 71.59% | 1.00 |
| Top 3 | Ettin 150M WSD | 205 / 5,523 (3.71%) | 68.45% | 35.95% | 2.82 |
| Top 3 | SayedShaun WSD | 327 / 5,523 (5.92%) | 68.02% | 35.09% | 2.82 |
| 1% calibrated margin | Ettin 150M WSD | 45 / 5,523 (0.81%) | 44.71% | 24.95% | 4.22 |
| 1% calibrated margin | SayedShaun WSD | 28 / 5,523 (0.51%) | 28.22% | 20.44% | 5.16 |
| 5% calibrated margin | Ettin 150M WSD | 211 / 5,523 (3.82%) | 77.47% | 43.75% | 2.29 |
| 5% calibrated margin | SayedShaun WSD | 253 / 5,523 (4.58%) | 68.99% | 35.92% | 2.77 |

Ettin wins both the Top 1 ranking comparison and the 5% calibrated filtering comparison. Its 5% filter removes 8.48 percentage points more non-gold definitions while excluding the gold in 42 fewer occurrences. At the more cautious 1% setting, SayedShaun misses the gold less often, but retains nearly one more definition per occurrence and removes 16.48 percentage points fewer non-gold definitions. Neither calibrated policy guarantees zero held-out gold exclusions.

The models were compared on paired occurrences. At Top 3, 193 cases retained gold only with Ettin and 71 only with SayedShaun (two-sided exact paired sign test, `p = 3.3e-14`). At the 5% margin, the corresponding counts were 150 and 108 (`p = 0.0106`). Ettin's Top 1 and Top 3 gold-retention rates were higher in each of the four held-out corpora.

The model card's approximately 80% reported cosine accuracy is not directly comparable. Its [published evaluation dataset code](https://github.com/sayedshaun/wsd/blob/main/dataset.py) limits the options to five and inserts the correct gloss when absent. This benchmark ranks every available WordNet candidate without that intervention.

## Speed with prepared sense vectors

Both runs used the local CPU, PyTorch `2.14.0+cpu`, Transformers `5.16.1`, and four PyTorch inference threads with `OMP_NUM_THREADS=1` and `OPENBLAS_NUM_THREADS=1`. Ettin full-set throughput came from its saved score checkpoint; the single-occurrence timings below were rerun for both models in this session.

| Measurement | Ettin | SayedShaun |
| --- | ---: | ---: |
| Full-set online throughput, 5,952 occurrences including calibration | 7.61/s | 47.73/s |
| Warm p50 / p95, one seven-definition Senseval-2 occurrence | 101.3 / 129.1 ms | 19.6 / 31.7 ms |
| Offline gloss preparation for this full candidate inventory | 0 | 119.8 s |

The SayedShaun online path is 6.27 times faster in the full batch and 5.18 times faster at the warmed median on this occurrence. The offline step encoded 9,776 unique gloss strings across 41,319 candidate entries and saved a 30 MB vector file. Online timing includes context tokenization, encoding, and vector scoring; it excludes that offline step. The single-occurrence measurement precomputed that word's seven gloss vectors before timing.

## Reader-card check and decision

The separate WordNet reader-card pilot has only 15 held-out occurrences and provisional `fits` / `plausible` / `clearly_wrong` labels. At Top 3, both models retained at least one acceptable definition in all 15; SayedShaun suppressed 86.5% of clearly wrong definitions versus Ettin's 83.7%. At the 5% calibration-only margin, SayedShaun retained all annotated acceptable definitions and suppressed 42.3% of clearly wrong ones, while Ettin hid an acceptable definition in 3 occurrences and suppressed 74.0%. This pilot is too small to establish a safety advantage.

Keep Ettin as the stronger tested filter. SayedShaun is a useful speed candidate if latency dominates, but its lower full-set precision and weaker 5% safety/removal trade-off do not support replacing Ettin for the stated objective. Neither model is established as safe for automatic production removal of acceptable reader definitions from these data alone.

## Reproduction

```sh
cd wsd
uv run python scripts/download_models.py sayedshaun-distilbert-base sayedshaun-wsd
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 uv run python scripts/evaluate_wordnet_filtering.py --model sayedshaun-wsd
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 uv run python scripts/benchmark_interactive.py --dataset raganato-senseval2 --model sayedshaun-wsd --example-index 7 --warmups 3 --repetitions 20
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 uv run python scripts/benchmark_interactive.py --dataset raganato-senseval2 --model ettin-150m-wsd --example-index 7 --warmups 3 --repetitions 20
```

Full metrics are in ignored `results/wordnet-filtering.csv`; raw scores and timing metadata are in ignored `results/checkpoints/wordnet-filtering-f3068ca160f3/`. The provisional reader-card results are in ignored `results/reader-wordnet-filter-pilot-filtering.csv`.
