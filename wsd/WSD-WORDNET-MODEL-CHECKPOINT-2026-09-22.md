# WordNet filtering model checkpoint

Updated 2026-09-23. WordNet sense order, Ettin-150M WSD, and ModernBERT Large
WSD are complete on all 5,523 held-out Raganato occurrences. The other four
requested models completed the reader-card pilot and the 252-case sampled
Raganato comparison.

The six requested models have all completed a reader-card pilot using the
repository's shipped WordNet definitions. The pilot has 24 calibration and 15
held-out occurrences (39 usable; three excluded because no fitting runtime
definition or POS group exists). Labels were assigned before model scoring by
Codex, so they are provisional rather than independent human judgments.

With a fixed limit of three definitions, the held-out results are:

| Ranker | No acceptable definition retained | All `fits` definitions hidden | At least one acceptable definition hidden | Clearly wrong definitions suppressed |
|---|---:|---:|---:|---:|
| WordNet sense order | 0/15 | 1/15 | 6/15 | 81.7% |
| DistilBERT WSD INT8 | 5/15 | 8/15 | 12/15 | 74.0% |
| MiniLM2 NLI INT8 | 2/15 | 6/15 | 13/15 | 75.0% |
| DistilBERT MNLI INT8 | 3/15 | 6/15 | 11/15 | 76.0% |
| MobileBERT MNLI q4f16 | 5/15 | 8/15 | 10/15 | 74.0% |
| Ettin 150M WSD | 0/15 | 2/15 | 5/15 | 83.7% |
| ModernBERT Large WSD (~395M) | 0/15 | 2/15 | 4/15 | 84.6% |

The FP32 DistilBERT WSD control also retained no acceptable definition in 5/15,
so this failure is not primarily caused by INT8 quantization. A calibration-only
margin chosen to retain all acceptable definitions on 90% of calibration cases
suppressed 51.0% of wrong definitions for Ettin 150M, with no `fits` loss and
one held-out occurrence losing a `plausible` definition. ModernBERT retained
all annotated acceptable definitions but suppressed only 16.3% of wrong ones.
The small pilot cannot establish a dependable safety rate.

The full Raganato WordNet benchmark has 429 SemEval-2007 calibration
occurrences and 5,523 held-out occurrences across four corpora. All three
models were scored on the same candidate sets. Accuracy counts an occurrence
as correct when at least one annotated gold synset is retained.

| Ranker | Top-1 accuracy | Top-3 accuracy | Top-3 gold excluded | Top-3 non-gold suppressed |
|---|---:|---:|---:|---:|
| WordNet sense order | 57.98% | 88.09% | 658/5,523 | 66.80% |
| Ettin-150M WSD | 76.63% | 96.29% | 205/5,523 | 68.45% |
| ModernBERT Large WSD (~395M) | 76.30% | 96.16% | 212/5,523 | 68.44% |

The WSD-trained models are close in Top-3 accuracy: Ettin retains gold in seven
more cases overall. Of their disagreements, 78 cases favor Ettin and 71 favor
ModernBERT. Both substantially improve over sense order. At the 5% margin
threshold calibrated only on SemEval-2007, the safety/filtering trade-off is:

| Ranker | Gold excluded | Non-gold suppressed | Mean definitions shown |
|---|---:|---:|---:|
| WordNet sense order | 258/5,523 (4.67%) | 35.86% | 4.67 |
| Ettin-150M WSD | 211/5,523 (3.82%) | 77.47% | 2.29 |
| ModernBERT Large WSD | 347/5,523 (6.28%) | 82.99% | 1.95 |

Ettin gives the stronger conservative filtering result on this benchmark.
ModernBERT removes more non-gold synsets at this threshold but excludes the
gold more often; its observed 6.28% miss rate exceeds the nominal 5%
calibration target.

Warm single-occurrence inference was measured on the same seven-definition
Senseval-2 example (`rest`, index 7), with three warmups and 20 repetitions
per model on an Intel Core i7-8700 CPU. The median/p95 score times were
0.0015/0.0019 ms for sense
order, 186/197 ms for Ettin-150M, and 532/544 ms for ModernBERT Large.
Model initialization took 0.2 ms, 6.0 s, and 7.4 s respectively. These are
one-example timings, not a latency distribution across WordNet words. Model
initialization excludes Python process and library import time. Full-set
batched throughput was 7.61 occurrences/s for Ettin and 1.86 occurrences/s
for ModernBERT on the same CPU.

A reproducible, corpus-balanced sample has 150 calibration and 252 held-out
occurrences (63 from each held-out corpus). Its completed Top 3 results are:

| Ranker | Gold sense excluded | Non-gold synsets suppressed |
|---|---:|---:|
| WordNet sense order | 32/252 (12.7%) | 66.2% |
| DistilBERT WSD INT8 | 56/252 (22.2%) | 64.3% |
| MiniLM2 NLI INT8 | 68/252 (27.0%) | 63.5% |
| DistilBERT MNLI INT8 | 76/252 (30.2%) | 63.0% |
| MobileBERT MNLI q4f16 | 55/252 (21.8%) | 64.6% |
| Ettin 150M WSD | 10/252 (4.0%) | 68.3% |
| ModernBERT Large WSD (~395M) | 6/252 (2.4%) | 68.6% |

At the calibration-only 5% score-margin threshold, Ettin 150M excluded the
gold sense in 8/252 cases, suppressed 74.4% of non-gold synsets, and showed
2.47 definitions on average. ModernBERT excluded it in 14/252 cases,
suppressed 84.0%, and showed 1.89 definitions. The nominal 5% threshold did
not translate to guaranteed held-out coverage for either model. Their Top 3
results favored ModernBERT on the small sample, while the full-set result
slightly favored Ettin. Ettin 150M provided the better conservative-margin
trade-off on both sets. All four held-out corpora showed fewer Top 3 gold exclusions
with both WSD-trained checkpoints than with sense order.

The three NLI checkpoints and DistilBERT WSD INT8 all performed worse than
WordNet sense order at Top 3 on this sample. These results do not justify a
production filter by themselves: the Raganato benchmark marks only exact
gold synsets as fitting, whereas a reader may reasonably accept multiple
definitions. The reader-card pilot has that richer label scheme but only 15
held-out cases and provisional annotations.

Reproduce the full-set results from saved score checkpoints with:

```sh
wsd/.venv/bin/python wsd/scripts/evaluate_wordnet_filtering.py \
  --model mfs ettin-150m-wsd modernbert-large-wsd
```

Reproduce the six-model sampled comparison with:

```sh
wsd/.venv/bin/python wsd/scripts/evaluate_wordnet_filtering.py \
  --calibration-dataset raganato-semeval2007-sample-150 \
  --evaluation-dataset raganato-heldout-sample-252 \
  --model mfs wordnet-sense-embedding-int8 nli-minilm2-int8 \
    distilbert-mnli-int8 mobilebert-mnli-q4f16 \
    ettin-150m-wsd modernbert-large-wsd
```

Completed results are in `results/reader-wordnet-filter-pilot-filtering.csv`,
`results/wordnet-filtering.csv`, and
`results/wordnet-filtering-sample-252.csv`; score checkpoints are in
`results/checkpoints/`. These generated result files are ignored by Git and
remain in this workspace. Independent review and more held-out reader-card
contexts are needed before a launch decision.
