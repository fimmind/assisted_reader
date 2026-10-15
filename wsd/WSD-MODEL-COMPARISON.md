# Browser WSD model comparison

The reader offers None, Light, and Heavier. Light uses SayedShaun WSD
(DistilBERT); Heavier uses Glite LENS seed-42. Both browser models use
quantized ONNX context encoders and precomputed float16 WordNet sense vectors.

## Ranking and filtering evidence

The native-model comparison uses 429 SemEval-2007 calibration occurrences and
5,523 held-out occurrences from Senseval-2, Senseval-3, SemEval-2013, and
SemEval-2015. All available WordNet candidates are scored without inserting a
gold sense into the options. These results are not a complete evaluation of the
quantized browser exports or nested vocabulary-card contexts.

| Model | Top 1 gold accuracy | Top 3 gold excluded | Top 3 non-gold removed |
| --- | ---: | ---: | ---: |
| SayedShaun WSD | 71.59% | 327 | 68.02% |
| Glite LENS | 80.01% | 145 | 68.68% |

Each filtering threshold is selected using calibration cases only. Each cell
below is gold excluded / 5,523; non-gold removed. A nominal miss target is not
a guaranteed held-out miss rate. Non-gold WordNet senses are not necessarily
unacceptable definitions for a reader.

| Calibration target | SayedShaun WSD | Glite LENS |
| --- | ---: | ---: |
| 0% | 0; 0% | 0; 0% |
| 1% | 28 (0.51%); 28.22% | 44 (0.80%); 59.89% |
| 2% | 129 (2.34%); 55.16% | 144 (2.61%); 75.79% |
| 3% | 167 (3.02%); 61.38% | 175 (3.17%); 78.41% |
| 4% | 229 (4.15%); 67.67% | 272 (4.92%); 84.74% |
| 5% | 253 (4.58%); 68.99% | 353 (6.39%); 87.59% |

Glite ranks gold senses more accurately and removes more non-gold definitions
at these thresholds, but also excludes gold more often. Neither model
establishes zero-loss filtering on held-out cases.

## Runtime trade-offs

The browser context limits are 256 tokens for SayedShaun and 324 for Glite,
including special tokens. Approximate quantized encoder sizes are 66.8 MB and
150.1 MB respectively. Each complete WordNet vector inventory occupies about
293 MB; the browser fetches vectors in buckets as needed.

Native CPU timings below use four PyTorch inference threads with
OMP_NUM_THREADS=1 and OPENBLAS_NUM_THREADS=1. Gloss vectors are prepared in
advance. These are workload-specific measurements, not browser latency claims.

| Measurement | SayedShaun WSD | Glite LENS |
| --- | ---: | ---: |
| Warm seven-definition occurrence, p50 / p95 | 18.6 / 20.2 ms | 51.0 / 55.6 ms |
| 39 short reader cards, online throughput | 28.11/s | 17.01/s |
| Full Raganato throughput, 5,952 occurrences | 47.73/s | 5.46/s |

The [SayedShaun checkpoint](https://huggingface.co/SayedShaun/word-sense-disambiguation)
uses the cosine architecture at revision
54e41c09c61ae8bd60c62e40bf483141c49ce0d3, with target markers and raw dot-product
scores. Its weights are MIT licensed. The
[Glite LENS checkpoint](https://github.com/GliteTech/research-semcor-relabeling)
uses the canonical lens-gpt55-s42 run, target-subword pooling, and structured
WordNet glosses. Its weights and derived vectors are CC BY-NC 4.0.

The reader's reduction margins use browser WASM calibration on 429
single-sentence occurrences. There is no controlled comparison here showing
that larger context windows or parent-card chains improve either model.

## Reproduction

```sh
cd wsd
uv run python scripts/download_models.py sayedshaun-distilbert-base sayedshaun-wsd
uv run python scripts/download_glite_lens.py
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 uv run python scripts/evaluate_wordnet_filtering.py --model sayedshaun-wsd glite-lens
uv run python scripts/report_wordnet_filter_sweep.py --model sayedshaun-wsd glite-lens
```
