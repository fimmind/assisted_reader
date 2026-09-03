# WSD / Gloss-Ranking Benchmark Plan for Assisted Reader

## 1. Project context

Assisted Reader is a browser-based reading application. A user can click a word in a text and see dictionary definitions for that word.

Current reader:
https://fimmind.github.io/assisted_reader/

The feature considered here is **context-aware ranking of dictionary definitions**.

Example:

```text
Context:
"He sat on the bank and watched the river."

Dictionary senses:
1. a financial institution that accepts deposits
2. the land alongside a river
3. a row or tier of objects
```

The desired ranking is:

```text
2 >> 1, 3
```

The application should remain essentially **serverless**. Inference should ideally happen entirely in the browser.

Therefore model size, initialization cost, browser compatibility, memory usage, and latency are first-class constraints.

---

# 2. Product objective

We are NOT primarily trying to solve academic fine-grained Word Sense Disambiguation perfectly.

The most important product requirement is:

> Definitions that are clearly incompatible with the context should almost never appear first.

Confusing two very similar dictionary senses is much less serious than showing a completely unrelated sense.

For example:

```text
Context:
"He deposited his salary at the bank."

bad error:
river bank ranked above financial institution

minor error:
two closely related financial senses reversed
```

Therefore exact WordNet sense accuracy should be measured, but it should not be the main optimization target.

The main target is approximately:

```text
low catastrophic-error rate
subject to
small model size + acceptable browser latency
```

---

# 3. Intended architecture

The preferred architecture is a gloss bi-encoder or similar embedding model.

Given:

```text
context c
target word w
candidate dictionary glosses g_1, ..., g_n
```

compute:

```math
v_c = E_context(c, w)
```

and

```math
v_i = E_gloss(g_i)
```

then score candidates by cosine similarity or dot product:

```math
s_i = sim(v_c, v_i)
```

and rank definitions by decreasing `s_i`.

A major advantage of the bi-encoder architecture is that embeddings for dictionary definitions can be computed **offline at build time**.

The browser then only needs to:

1. tokenize/contextualize the current sentence;
2. compute one context embedding;
3. compare it with a small number of precomputed candidate gloss embeddings;
4. sort the definitions.

No vector database or ANN index is required because the candidate set is already restricted to senses of the clicked word.

---

# 4. Candidate model families

At minimum benchmark the following classes.

## 4.1 Frequency baseline

No neural model.

Rank definitions by sense frequency.

If WordNet ordering/frequency information is available, use Most Frequent Sense (MFS).

Also test:

```text
POS filter + Most Frequent Sense
```

This is an important baseline because any neural model must improve enough over MFS to justify downloading and running it.

---

## 4.2 Generic sentence embedding models

Example family:

```text
E5-small
MiniLM
other compact sentence-transformer-style models
```

These models are not trained specifically for WSD.

They are useful because:

- compact quantized ONNX variants often already exist;
- browser deployment is easy;
- they provide a strong engineering baseline.

Score:

```math
sim(
    E("target word + context"),
    E("target word + definition")
)
```

Possible input formatting:

```text
Context:
"Target word: bank. Context: He sat on the bank beside the river."

Gloss:
"bank. noun. The land alongside a river or lake."
```

Test several simple templates if useful, but do not tune them on the final test set.

---

## 4.3 Specialized gloss bi-encoders

Important candidates already identified:

### `marksverdhei/wordnet-sense-embedding`

DistilBERT-based model explicitly trained to bring a target word in context close to the correct WordNet gloss and away from competing senses.

Interesting because its training objective closely matches the Assisted Reader task.

The original implementation uses target-token pooling rather than ordinary whole-sentence mean pooling.

Likely requires an ONNX/browser port.

---

### Babelscape WSL retriever

Candidate:

```text
Babelscape/wsl-retriever-e5-base-v2
```

This is the retrieval component of a Word Sense Linking system.

The full WSL architecture has a retriever plus a more expensive reader/reranker, but Assisted Reader already knows the lemma and candidate dictionary senses.

Therefore the retriever alone may be sufficient.

Potential downside:

- considerably larger than small E5 models;
- check licensing before deciding whether it is suitable for production.

---

## 4.4 Classical BEM

Reference implementation/paper:

```text
Blevins & Zettlemoyer
Moving Down the Long Tail of Word Sense Disambiguation with Gloss Informed Bi-encoders
ACL 2020
```

This is an important methodological baseline/reference.

Its original code is old and not necessarily the preferred production implementation.

Do not spend substantial engineering effort on porting it before simpler candidates have been benchmarked.

---

## 4.5 Very small WSD/semantic models

Investigate compact specialized models, including small ModernBERT-style semantic/WSD encoders.

These are interesting primarily for the size/quality Pareto frontier.

Do not assume that a model trained on a coarse semantic inventory will transfer perfectly to fine-grained dictionary senses.

---

# 5. Evaluation philosophy

Do NOT reduce all experiments to one universal WSD number.

Different datasets measure substantially different phenomena.

Instead:

1. convert datasets to a shared internal representation;
2. run one evaluation pipeline;
3. report each dataset separately;
4. optionally report aggregate product metrics only where semantically meaningful.

---

# 6. Unified example schema

Normalize benchmark examples approximately as follows:

```json
{
  "id": "example-id",
  "dataset": "reader-test-v1",

  "context": "He sat on the bank and watched the river.",
  "target": "bank",
  "lemma": "bank",
  "pos": "NOUN",

  "candidates": [
    {
      "sense_id": "bank.financial",
      "gloss": "a financial institution that accepts deposits"
    },
    {
      "sense_id": "bank.river",
      "gloss": "the land alongside a river"
    },
    {
      "sense_id": "bank.row",
      "gloss": "a row or tier of similar objects"
    }
  ],

  "gold": ["bank.river"]
}
```

For the product-specific dataset, candidates may additionally contain relevance annotations:

```json
{
  "sense_id": "bank.financial",
  "relevance": "clearly_wrong"
}
```

Recommended relevance labels:

```text
fits
plausible
clearly_wrong
```

Potential numeric representation:

```text
fits          = 2
plausible     = 1
clearly_wrong = 0
```

Do not force human annotators to distinguish fine-grained senses when that distinction is not useful for the reader UX.

---

# 7. Benchmark datasets

Use several complementary datasets.

## 7.1 Raganato Unified WSD evaluation framework

Use the unified English WordNet WSD evaluation suite based on classic Senseval/SemEval all-words datasets.

Purpose:

```text
fine-grained standard academic WSD
```

This answers:

> Can the model identify the exact WordNet sense?

Useful metrics:

```text
Top-1 accuracy / F1
MRR
```

This should be treated as an academic sanity check, not the primary product target.

Do not train or tune on these test sets.

---

## 7.2 CoarseWSD-20

High priority for this project.

Purpose:

```text
coarse sense discrimination
```

This dataset focuses on a limited set of ambiguous words with relatively distinct senses.

It is especially useful for the question:

> Can the model distinguish obviously different meanings?

This is much closer to the main product objective than extremely fine WordNet distinctions.

Report this separately from fine-grained WSD.

---

## 7.3 MASC WordNet annotations

High priority.

Useful because it contains many naturally occurring instances of common ambiguous words.

It allows analysis not only by example but also by lemma.

Useful analyses:

```text
accuracy by lemma
MRR by lemma
error rate vs sense frequency
error rate vs ambiguity
```

This is particularly useful for detecting models that work well on average but fail badly on certain common polysemous words.

---

## 7.4 WiC

Optional diagnostic benchmark.

WiC asks whether the same word is used with the same meaning in two contexts.

It does not directly test gloss ranking.

Use only as a diagnostic of contextual semantic representations.

Do not include WiC in any main gloss-ranking aggregate score.

---

## 7.5 XL-WSD

Optional future benchmark.

Relevant if Assisted Reader later supports multilingual WSD.

Not necessary for the initial English-only evaluation.

---

# 8. Product-specific dataset: Reader Test Set

This is the most important benchmark.

Create a held-out set consisting of real examples similar to those encountered by Assisted Reader users.

Prefer examples from actual books/texts handled by the application.

For every example store:

```text
context
target word
the actual definitions shown by the reader
human relevance labels
```

The definitions must come from the same dictionary source/pipeline used by the product.

This is important because performance on WordNet glosses does not necessarily predict performance on another dictionary's definitions.

---

## 8.1 Suggested initial size

For a first useful version:

```text
300–1000 target-word occurrences
```

Even approximately 300 carefully selected examples can already be very informative for comparing models.

Try to include:

```text
common polysemous words
rare words
nouns
verbs
adjectives
2-sense words
words with many dictionary senses
very obvious sense contrasts
closely related senses
short contexts
longer contexts
literary language
dialogue
```

---

## 8.2 Annotation

For each candidate definition label it:

```text
fits
plausible
clearly_wrong
```

Multiple definitions may be `fits` or `plausible`.

This is intentional.

The product does not require annotators to decide between two definitions when either would be useful to the reader.

If possible, have two people independently annotate a subset to estimate agreement.

Disagreements themselves are useful: they indicate intrinsically ambiguous cases.

---

# 9. Main metrics

## 9.1 Exact Top-1 accuracy

For datasets with exact gold senses:

```math
Accuracy =
correct_top1 / N
```

Useful for traditional WSD.

Not sufficient for the product.

---

## 9.2 Mean Reciprocal Rank

```math
MRR =
\frac{1}{N}
\sum_i
\frac{1}{rank_i}
```

Important because Assisted Reader presents a ranked list rather than only one predicted label.

If multiple senses are acceptable, use the rank of the first acceptable candidate.

---

## 9.3 Top-1 Acceptable Rate

For Reader Test Set:

```math
Top1Acceptable =
P(top1 \in \{fits, plausible\})
```

This is one of the primary product metrics.

---

## 9.4 Catastrophic Error Rate

Primary metric.

```math
CER =
P(top1 = clearly_wrong)
```

Interpretation:

> How often does the reader put an obviously irrelevant definition first?

Lower is better.

A model with slightly lower exact WSD accuracy but much lower CER may be preferable.

---

## 9.5 Pairwise good-vs-bad ranking accuracy

For all pairs consisting of:

```text
acceptable gloss
vs
clearly wrong gloss
```

measure:

```math
P(
score(acceptable)
>
score(clearly\_wrong)
)
```

This directly measures the behavior that matters for definition sorting.

It is particularly useful because it is insensitive to ordering disagreements among several plausible definitions.

---

## 9.6 Optional ranking metric: nDCG

Because Reader Test Set has graded relevance:

```text
fits          = 2
plausible     = 1
clearly_wrong = 0
```

compute:

```text
nDCG@3
```

or similar.

This gives a compact metric for the quality of the first few displayed definitions.

Use it as a secondary metric; keep CER directly visible because it is easier to interpret.

---

# 10. Efficiency metrics

All candidate models must be evaluated not only for quality but also for browser deployment.

Record:

```text
original model size
quantized model download size
tokenizer size
total network download
cold initialization time
warm inference latency
peak memory if measurable
browser/backend used
```

At minimum report:

```text
INT8 total MB
cold-load time
p50 inference latency
p95 inference latency
```

Benchmark on at least one realistic Android phone, not only desktop Python.

If WebGPU is intended for production, benchmark WebGPU.

If a WASM fallback is required, benchmark that separately.

---

# 11. Context variants

Evaluate at least a few context extraction strategies.

For example:

### sentence

```text
current sentence only
```

### local window

```text
previous sentence + current sentence + next sentence
```

### token window

```text
±N tokens around the target
```

Do not assume that more context is always better.

For each model, compare a small fixed set of context policies.

Avoid extensive tuning against the final Reader Test Set.

---

# 12. Gloss representation

Compare simple representation choices.

At minimum:

```text
definition only
```

versus

```text
lemma + POS + definition
```

and, when available:

```text
lemma + POS + definition + example sentence
```

Potential format:

```text
bank. noun.
The land alongside a river or lake.
Example: We sat on the river bank.
```

Examples and synonyms may improve performance, but they also increase preprocessing/storage.

Measure rather than assume.

---

# 13. Precomputing gloss embeddings

For bi-encoder models:

```text
dictionary → encoder → static sense vectors
```

should happen at build time.

Store embeddings alongside dictionary entries.

Possible storage options:

```text
Float32
Float16
INT8 / scalar quantization
```

Measure how much gloss-vector storage matters relative to model download size.

Since ranking is only among the senses of one lemma, approximate nearest-neighbor indexing is unnecessary.

---

# 14. Model comparison

Do not collapse size and quality into one arbitrary weighted score.

Instead build a Pareto comparison.

For example:

```text
x-axis: quantized download size
y-axis: catastrophic error rate
```

Secondary dimensions:

```text
MRR
latency
exact WSD accuracy
```

An example result table:

```text
Model                 MB    CER ↓   Top1 acceptable ↑   MRR ↑   WSD acc ↑

MFS                    0     8.0%        92.0%            ...      ...
POS + MFS              0     6.5%        93.5%            ...      ...

E5-small INT8         35     4.5%        95.5%           .89       ...
Small WSD encoder     50     2.5%        97.5%           .93       ...
BEM-style model       70     1.8%        98.2%           .94       ...
Large WSL retriever  110     1.5%        98.5%           .95       ...
```

Numbers above are illustrative only.

The final choice should probably be a model near the Pareto frontier rather than the model with the absolute highest academic WSD score.

---

# 15. Training policy

## Do not train a language encoder from scratch

This is almost certainly unnecessary.

We do not need to teach a model English.

---

## First benchmark pretrained models

Initial workflow:

```text
1. implement common evaluation framework
2. run simple baselines
3. run generic compact encoders
4. run specialized gloss encoders
5. quantize promising candidates
6. measure browser performance
```

Only after this should custom training be considered.

---

## Fine-tuning may be useful later

Fine-tuning a compact pretrained encoder on WSD/gloss-ranking data may be realistic on consumer hardware.

Potential objective:

```math
L =
-\log
\frac{
\exp(sim(c,g^+)/\tau)
}{
\exp(sim(c,g^+)/\tau)
+
\sum_j \exp(sim(c,g_j^-)/\tau)
}
```

where negatives should preferably include **other senses of the same lemma**.

These are hard negatives and closely match the production task.

Potential training sources:

```text
SemCor
other sense-annotated corpora
synthetic examples if carefully validated
future user interaction data
```

Do not use the final test sets for training.

---

# 16. Test-set hygiene

Freeze the Reader Test Set early.

For example:

```text
reader-test-v1.jsonl
```

Once frozen:

```text
never train on it
never generate synthetic training examples from it
avoid manual prompt/model tuning directly against it
```

Create a separate:

```text
reader-dev-v1
```

for development and hyperparameter choices.

This becomes especially important if the project later fine-tunes its own encoder.

---

# 17. SemCor

SemCor should primarily be treated as training/dev material, not as the main independent evaluation benchmark.

Many WSD systems have already been trained on it.

A high score on examples overlapping typical WSD training distributions therefore tells us less than performance on independent reader data.

---

# 18. Suggested repository structure

Possible layout:

```text
wsd/
    README.md

    data/
        raw/
        processed/

        reader-dev-v1.jsonl
        reader-test-v1.jsonl

    adapters/
        base.py
        mfs.py
        e5.py
        wordnet_sense_embedding.py
        wsl_retriever.py

    evaluation/
        metrics.py
        evaluate.py
        report.py

    scripts/
        prepare_raganato.py
        prepare_coarsewsd.py
        prepare_masc.py
        build_gloss_embeddings.py
        export_onnx.py

    browser/
        benchmark.html
        benchmark.ts

    results/
        benchmark.csv
        benchmark.md
```

The exact language/framework can of course follow the existing repository.

---

# 19. Model adapter interface

Every model should expose the same conceptual API:

```python
class SenseRanker:
    def prepare_senses(self, senses):
        """
        Optional offline preprocessing.
        Returns representations for candidate glosses.
        """

    def score(
        self,
        context,
        target,
        lemma,
        pos,
        senses
    ):
        """
        Return one score per candidate sense.
        Higher = more contextually appropriate.
        """
```

This allows the evaluator to treat:

```text
MFS
generic embeddings
gloss bi-encoders
cross-encoders
future custom models
```

uniformly.

---

# 20. Evaluation output

Generate both machine-readable and human-readable results.

Example CSV columns:

```text
model
dataset
model_mb
quantization
context_policy
top1_accuracy
mrr
top1_acceptable
catastrophic_error_rate
pairwise_good_bad_accuracy
ndcg_3
latency_p50_ms
latency_p95_ms
```

Also generate breakdowns by:

```text
lemma
POS
number of senses
sense frequency
context length
coarse vs fine ambiguity
```

These breakdowns may reveal much more than aggregate scores.

---

# 21. First milestone

The first implementation should be deliberately small.

### Phase 1

Implement:

```text
MFS
POS + MFS
one compact generic embedding model
marksverdhei/wordnet-sense-embedding
```

Datasets:

```text
CoarseWSD-20
one standard Raganato test suite
small reader-dev set
```

Metrics:

```text
Top-1
MRR
CER on reader data
model size
```

Do not begin custom training yet.

---

### Phase 2

Add:

```text
MASC
full Raganato ALL
larger reader-test-v1
Babelscape WSL retriever
ONNX quantization
real browser benchmarks
```

---

### Phase 3

Only if needed:

```text
fine-tune a small pretrained encoder
hard-negative training on competing senses
distillation from a larger WSD model
INT8 / INT4 experiments
```

Distillation may be particularly attractive if a large WSD model performs substantially better than all compact models.

---

# 22. Decision criterion

The project should not automatically choose the model with the highest exact WSD accuracy.

The preferred production model should approximately minimize:

```text
catastrophic definition-ranking errors
```

while satisfying practical constraints on:

```text
download size
browser startup
inference latency
memory
licensing
```

A useful decision plot is:

```text
Catastrophic Error Rate
        ↑
        |
        |         model C
        |
        |    model B
        |
        | model A
        +--------------------→ model size
```

Models dominated in both size and product quality can be discarded.

The interesting models lie on the Pareto frontier.

---

# 23. Core hypothesis to test

The central experimental question is:

> Does a WSD-specific gloss bi-encoder reduce obvious sense-ranking errors enough to justify its additional browser cost compared with a small generic sentence embedding model?

This should be answered empirically rather than assumed.

A second question is:

> How small can the model become before coarse sense discrimination noticeably degrades?

This directly connects the ML evaluation to the Assisted Reader product constraints.