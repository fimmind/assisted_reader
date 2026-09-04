# Assisted Reader WSD — next Codex session

## Objective

Continue the existing `wsd/` workbench.

Do not redesign the benchmark infrastructure and do not touch production reader behavior yet.

The immediate research question is now narrower:

> Given that contextual POS already removes many obviously wrong definitions, which small semantic ranker best orders competing definitions **within the correct POS group**?

A second goal is to enlarge the product-oriented development data enough that conclusions are not driven by 28 examples.

There is currently no independent user-derived test set. Do not invent one.

Use a larger LLM-assisted dataset as:

```text
reader-dev-v2
```

and clearly document that it is development/evaluation data, not an unbiased final test set.

---

# 1. Read current state before changing anything

Start by reading:

```text
wsd/README.md
wsd/NEXT-CODEX-CHECKPOINT.md
wsd/PROGRESS-2026-09-03.html
wsd/scripts/rankers.py
wsd/scripts/metrics.py
wsd/scripts/evaluate.py
wsd/scripts/build_reader_dev_draft.py
```

Preserve the product invariant:

> Every dictionary definition remains visible. WSD only changes definition ordering.

Do not implement definition filtering.

Do not modify the production reader during this session.

---

# 2. Important fact about the current POS rankers

Do not implement another "semantic reranking inside POS" wrapper unless genuinely different behavior is required.

The existing:

```text
pos-e5-small
pos-wordnet-sense-embedding
```

already enforce POS-first grouping and preserve semantic score ordering within the matching POS group.

The `+2.1` POS boost intentionally dominates cosine similarity.

Therefore the next analysis should focus on how well models perform **inside that matching POS group**.

---

# 3. Expand the reader development dataset

The current 28-example dataset is too small for model selection.

Create a new:

```text
reader-dev-v2
```

Target roughly:

```text
100–250 useful contextual occurrences
```

Do not force a fixed count if the source material does not naturally provide enough good examples.

Quality and diversity matter more than hitting a quota.

---

## 3.1 Remove the current one-occurrence-per-lemma restriction

The current draft builder effectively keeps at most one occurrence of a lemma per source book.

Change this.

Multiple occurrences of the same lemma are valuable because they test whether the model reacts to context.

For example:

```text
company → commercial organization
company → companionship / presence of other people
```

is much more informative than testing `company` only once.

Allow several occurrences per lemma.

Suggested cap:

```text
3–5 occurrences per lemma
```

to prevent a few very common words from dominating the dataset.

Deduplicate near-identical contexts.

Use stable occurrence IDs based on source location rather than only lemma.

---

# 4. Prefer same-POS ambiguous examples

The main unresolved problem is no longer:

```text
noun vs verb
```

but:

```text
noun sense A vs noun sense B
```

Therefore record for every example:

```text
number_of_candidates
number_of_matching_pos_candidates
```

and make sure the enlarged dataset contains many examples with:

```text
matching_pos_candidates >= 2
```

Preferably a substantial fraction should have:

```text
matching_pos_candidates >= 3
```

Do not, however, throw away easier natural examples entirely.

The full reader-dev-v2 should still resemble the product.

---

# 5. Maintain two evaluation slices from the same data

Do not create two separately annotated datasets unless necessary.

Instead evaluate reader-dev-v2 as:

## Full reader slice

All valid ambiguous reader examples.

This measures actual end-to-end ranking behavior.

## Same-POS hard slice

Examples satisfying approximately:

```text
at least two candidate definitions match contextual POS
```

This measures the semantic reranker after POS has done its job.

Report both separately.

Possible names:

```text
reader-dev-v2/full
reader-dev-v2/same-pos
```

---

# 6. POS must come from the product pipeline where practical

Avoid growing the manually maintained `CONTEXTUAL_POS` table.

Inspect the existing production NLP path:

```text
src/core/nlp.ts
src/core/definition-target.ts
src/core/lexicon.ts
```

and reuse the actual contextual POS inference if reasonably possible.

Preferred outcome:

```text
dataset POS == POS the deployed reader would infer
```

If importing the runtime TypeScript path directly into the dataset builder is awkward, create the smallest sensible shared/helper path rather than manually annotating hundreds of POS values.

Do not silently substitute a completely different POS tagger for dataset generation.

Keep exact-displayed-word-first lookup behavior consistent with production.

---

# 7. Preserve actual runtime dictionary candidates

Every example must contain the definitions that Assisted Reader would actually show for that lookup.

Do not replace Wiktionary/Wiktextract definitions with WordNet glosses.

Do not remove inconvenient definitions.

Do not hand-pick only "nice" candidate sets after seeing model predictions.

Store:

```text
target
lookup_word
lemma
contextual POS
context
source location
all candidate definitions
candidate POS
original dictionary order
```

Original dictionary order is important because it is a useful zero-cost prior.

---

# 8. Codex-assisted annotation is acceptable for reader-dev-v2

There are currently no users from whom to obtain a naturally annotated dataset.

It is acceptable to use Codex to provisionally annotate reader-dev-v2.

Use the existing three relevance labels:

```text
fits
plausible
clearly_wrong
```

Interpret them as follows.

### fits

The definition directly describes the meaning of the target in this context.

### plausible

The definition is close enough that showing it near the top would still be useful or defensible.

This includes dictionary distinctions that are finer than the product needs.

### clearly_wrong

The definition is incompatible with the contextual meaning.

The product objective is primarily to demote these.

---

## 8.1 Annotation principle

Do NOT force exactly one `fits` definition.

Multiple definitions may be:

```text
fits
```

or:

```text
plausible
```

when the dictionary inventory distinguishes meanings more finely than the context/product requires.

The benchmark is not trying to manufacture a single fine-grained gold sense.

---

## 8.2 Preserve uncertainty

If an example genuinely cannot be annotated confidently, do not fabricate certainty.

Allow annotation metadata such as:

```text
annotation_confidence:
    high
    medium
    low
```

or:

```text
needs_review
```

Low-confidence examples may remain in the dataset but should be inspectable separately.

The evaluator does not need to use confidence in its primary metrics.

---

## 8.3 Check annotation stability

After provisional annotation, perform a second review pass on at least:

```text
all low-confidence examples
all surprising model errors
a random sample of otherwise normal examples
```

Preferably review candidate definitions without relying on previous model rankings.

The purpose is to catch annotation mistakes, not to tune labels to make a model look better.

---

# 9. Add metrics that isolate semantic ranking

Keep existing metrics.

Add the following.

---

## 9.1 Raw counts

For every percentage reported on reader data, also report:

```text
errors / examples
```

Example:

```text
CER@1 = 7 / 28 = 25.0%
```

This is especially important while datasets remain small.

---

## 9.2 Top-2 acceptable rate

Add:

```text
Top2Acceptable
```

Definition:

> Does at least one `fits` or `plausible` definition appear among the first two results?

This has a straightforward reader UX interpretation.

---

## 9.3 Same-POS pairwise accuracy

This is a high-priority new metric.

Current pairwise accuracy mixes:

```text
cross-POS comparisons
same-POS comparisons
```

but cross-POS ranking is already largely solved deterministically by POS-first ordering.

Add:

```text
PairwiseSamePOS
```

For pairs where:

```text
acceptable definition
vs
clearly wrong definition
```

count the pair only when both definitions belong to the contextual POS.

Measure:

```math
P(score(acceptable) > score(wrong) | same POS)
```

This is probably the cleanest current measure of whether a semantic encoder is helping.

---

## 9.4 Same-POS Top-1 / CER

On the `same-pos` slice report:

```text
Top1Acceptable
CER@1
MRR
```

This should become one of the main model-comparison tables.

---

## 9.5 Score margin

For semantic models, compute per example:

```text
best acceptable semantic score
-
best clearly-wrong semantic score
```

Call it something like:

```text
acceptable_wrong_margin
```

Use the **base semantic scores before the artificial POS boost**.

This distinguishes:

```text
barely wrong ranking
```

from:

```text
very confident nonsense
```

Add margin information to error reports.

---

# 10. Improve error reports

Extend `report_top_errors.py` or add a complementary report.

For every catastrophic top-1 error show:

```text
context
target
contextual POS

candidate rank
candidate POS
relevance
raw semantic score
final POS-adjusted score
original dictionary rank
definition
```

Also generate a report for:

```text
worst same-POS margins
```

This will make debugging individual encoders much more useful than aggregate accuracy alone.

---

# 11. Run CoarseWSD-20

The normalized CoarseWSD-20 data already exists.

Evaluate it before adding many new models.

Keep it a separate diagnostic.

Do not combine its score numerically with reader-dev or Raganato.

Its purpose is:

> Can the model distinguish genuinely different meanings?

Record at least:

```text
Top-1
MRR
mapping coverage
```

Do not treat unmapped WordNet labels as failures of the product-ranking system.

---

# 12. Re-evaluate current models on reader-dev-v2

Run:

```text
dictionary order
pos-order

e5-small
pos-e5-small

wordnet-sense-embedding
pos-wordnet-sense-embedding
```

Main comparison should emphasize:

```text
reader-dev-v2 same-POS metrics
```

not Raganato alone.

Keep Raganato as an academic sanity check.

---

# 13. Add Babelscape WSL retriever

Next specialized candidate:

```text
Babelscape/wsl-retriever-e5-base-v2
```

Before implementing:

1. read the current model card;
2. verify the intended query/document formatting;
3. verify how target mentions are represented;
4. check whether arbitrary candidate glosses can be scored directly;
5. record license information.

Implement it through the existing `Ranker` interface.

Evaluate:

```text
raw WSL retriever
POS + WSL retriever
```

The model is currently research-only for this project if its non-commercial license remains unchanged.

Do not treat it as a production candidate without a later license review.

Its value now is as a quality reference.

---

# 14. Add one or two compact generic encoders

The project cares strongly about model weight.

Add at most two compact generic controls.

Reasonable families to investigate include:

```text
MiniLM
BGE-small
```

Choose specific checkpoints only after checking:

```text
model size
license
sentence-embedding usage
current availability
eventual ONNX / browser feasibility
```

Do not add a large collection of nearly identical generic encoders.

The goal is to establish the compact-model frontier, not create a leaderboard zoo.

---

# 15. Add a zero-model lexical baseline

Because production model size is important, add at least one semantic-ish baseline with effectively zero neural download cost.

For example:

```text
POS-first + lexical overlap / BM25-style score
```

between:

```text
context
```

and:

```text
definition
```

This is expected to be weak on many examples, but it is worth measuring.

If it removes a meaningful fraction of catastrophic errors at essentially zero model cost, that matters.

Keep implementation simple.

Do not spend substantial time optimizing it.

---

# 16. Test dictionary order as a prior

The current semantic models sometimes rank acceptable definitions above bad definitions pairwise while still producing poor top-1 choices.

A likely useful signal is the existing dictionary order.

After reader-dev-v2 is available, test a small number of hybrid rankers.

Conceptually:

```text
POS
then
semantic relevance + dictionary-order prior
```

Prefer a scale-robust method such as rank fusion if model score scales differ substantially.

For example investigate:

```text
semantic rank only
dictionary rank only
simple reciprocal-rank fusion
```

Do not run a large hyperparameter search.

A tiny dev-only sweep is sufficient.

The aim is to determine whether the dictionary's default ordering stabilizes semantic outliers.

---

# 17. Small context/gloss ablation

Only after the larger dev dataset exists, test a small fixed matrix.

Do not perform exhaustive prompt engineering.

Possible context representations:

```text
current sentence
local wider context, if easily available from source
```

Possible gloss representations:

```text
definition only
lemma + POS + definition
```

For specialized models, preserve their documented format unless there is a strong reason not to.

Report these ablations separately.

Choose one sensible formulation and then stop tuning it.

---

# 18. Do not train a custom model in this session

No training from scratch.

No fine-tuning yet.

No distillation yet.

The current question is still:

> Are any existing small models already good enough?

Custom training becomes relevant only if the new benchmark shows a persistent quality gap between:

```text
small deployable models
```

and:

```text
larger/specialized reference models
```

---

# 19. Do not begin browser integration yet

Do not integrate a WSD encoder into the React reader during this session.

Do not spend substantial time on:

```text
Transformers.js
WebGPU
ONNX conversion
INT8
INT4
browser caching
production bundle design
```

until the quality comparison identifies at least one promising small model.

A rough parameter/download-size note is useful, but deployment benchmarking remains Phase 2.

---

# 20. Desired result table

Produce a table roughly like:

```text
Model                   Full CER   Same-POS CER   Same-POS pairwise   Top2   MRR
---------------------------------------------------------------------------------
dictionary order
POS order
lexical + POS
E5-small + POS
WN-sense-embedding + POS
MiniLM/BGE + POS
WSL retriever + POS
hybrid best candidate
```

Also keep:

```text
Raganato exact WSD
CoarseWSD diagnostic
```

in separate tables.

Do not create one universal aggregate score.

---

# 21. Model-size table

Even before browser benchmarking, maintain a separate approximate engineering table:

```text
model
parameter count
checkpoint size
license
generic vs WSD-specific
known ONNX availability
likely browser feasibility
```

Do not confuse local Hugging Face cache size with browser download size.

No production size claim should be made yet.

---

# 22. Expected decision after this session

At the end, we want to know:

### Question A

Does a specialized gloss/WSD encoder materially outperform compact generic encoders on **same-POS reader ambiguities**?

### Question B

Does dictionary-order prior improve top-1 reliability without destroying semantic gains?

### Question C

How much improvement over POS-only is actually available?

### Question D

Is there already a small model worth taking to Phase 2 browser/ONNX testing?

---

# 23. Suggested priorities

If time or compute is limited, do work in this order:

```text
1. Improve metrics with same-POS evaluation.
2. Expand and annotate reader-dev-v2.
3. Re-run existing rankers.
4. Run CoarseWSD.
5. Add Babelscape WSL retriever.
6. Add one compact generic encoder.
7. Try dictionary-order + semantic rank fusion.
8. Add second compact encoder only if useful.
9. Context/gloss ablation.
```

Do not sacrifice steps 1–3 in order to test more models.

---

# 24. Deliverables

Before ending the session:

## Code

Working scripts for:

```text
reader-dev-v2 construction
validation
same-POS metrics
enhanced error reporting
new ranker adapters
```

as applicable.

## Data

A reproducible:

```text
reader-dev-v2
```

with provenance and annotation metadata.

Do not commit model weights or downloaded external benchmark corpora.

## Results

Machine-readable benchmark CSVs plus a concise human-readable report.

## Documentation

Update:

```text
wsd/README.md
```

only where workflow has actually changed.

Replace or supersede:

```text
wsd/NEXT-CODEX-CHECKPOINT.md
```

with a new checkpoint containing:

```text
what changed
exact dataset sizes
exact metrics
models tested
important errors
open questions
commands needed to reproduce results
```

Do not merely say "improved" or "worse"; record actual numbers.

---

# 25. Final constraint

Do not optimize toward exact WordNet sense selection at the expense of the product objective.

The preferred system is still the one that:

> almost never puts a clearly inappropriate definition first,

while remaining small enough to run locally in a browser.

Confusing two close, defensible dictionary definitions remains a secondary error.