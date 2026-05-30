# Site Algorithms (Current Implementation)

This document describes the algorithmic components currently used by the static reader in `site/`.
It covers both:

- Runtime browser logic (`site/app.js`)
- Offline asset generation that runtime logic depends on (`scripts/*.py`, `src/vocab_benchmark/*`)

The site is fully static and standalone at runtime. All model/data assets are loaded from `site/data/*`.

---

## 1. Text Tokenisation and Sentence Detection

### 1.1 Summary

Implementation uses a hybrid approach:

- Regex sentence splitting for scope analysis (`splitSentences`)
- Token extraction through `compromise` NLP terms (`tagSentenceTerms`) with a regex fallback
- Book structure parsing from TXT/EPUB into chapter paragraphs first, then sentence-level analysis where needed

Runtime dependencies:

- `compromise` (browser CDN): term tokenization + POS/proper noun tags
- `JSZip` (browser CDN): `.epub` archive parsing
- Browser `DOMParser`: XML/HTML parsing for EPUB manifests/content
- Native JS regexes for deterministic fallback segmentation

### 1.2 Technical Specification

#### 1.2.1 Core Regexes

Defined in `site/app.js`:

- Word regex: `WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)?/g`
  - Matches alphabetic tokens, optionally with one apostrophe segment (`don't`, `it's`)
- Sentence regex: `SENTENCE_RE = /[^.!?]+[.!?]+|[^.!?]+$/g`
  - Greedy extraction of chunks ending with `. ! ?`, plus final trailing chunk

`splitSentences(text)`:

1. `text.matchAll(SENTENCE_RE)`
2. Trim each chunk
3. Drop empty chunks

#### 1.2.2 Tokenization Pipeline

`tagSentenceTerms(sentence)`:

1. Build fallback terms from `WORD_RE`:
   - Each token has `{raw, normalized, tags: empty Set}`
   - `normalized = lowercased + typographic apostrophe normalized`
2. If `compromise` is available:
   - `nlp(sentence).terms().json()`
   - Flatten nested term nodes
   - Extract raw term text, derive tag set from `term.tags`
   - Re-run `WORD_RE` on each term string to preserve only word-like chunks
3. Return compromise-derived tokens if non-empty, otherwise fallback terms

`buildTaggedSentences(text)`:

- Runs `splitSentences` and then `tagSentenceTerms` per sentence.

#### 1.2.3 Book Parsing Before Sentence Detection

TXT (`parseTxtBook`):

- Chapter boundaries via regex `^\s*(chapter\s+\d+.*)$` (case-insensitive, multiline)
- If no headings found, single chapter fallback
- Paragraphs split on blank lines: `/\n\s*\n+/`
- Paragraph whitespace normalized to single spaces

EPUB (`parseEpubBook`):

1. Open ZIP via `JSZip.loadAsync`
2. Read `META-INF/container.xml` and resolve OPF package path
3. Parse OPF manifest + spine via `DOMParser`
4. For each spine item:
   - Load XHTML/HTML file
   - Chapter title from first `h1/h2/title` fallback
   - Paragraphs from `<p>` nodes; if absent, fallback split by punctuation boundary
5. Normalize spaces for extracted text

#### 1.2.4 Data/Assets Required

- Runtime: `site/index.html` loads:
  - `https://unpkg.com/compromise@14.15.0/builds/compromise.min.js`
  - `https://unpkg.com/jszip@3.10.1/dist/jszip.min.js`
- No server-side tokenization required.

---

## 2. Deinflection

### 2.1 Summary

Deinflection is a candidate-based lemmatization layer designed to align text tokens with model vocabulary:

- Uses a precomputed dictionary (`site/data/lemma_dict.json`)
- Uses `compromise` morphological transforms when available
- Chooses the first candidate present in the model vocabulary map (`wordToIdx`)
- Integrates proper noun exclusion at the same stage

Runtime dependencies:

- `compromise` for inflection transforms
- Static lemma dictionary JSON

### 2.2 Technical Specification

#### 2.2.1 Candidate Generation (`makeLemmaCandidates`)

Input: raw token string + compromise term tags.

Candidate sources, in exact order:

1. `lemma_dict[normalized]` if present
2. If token tagged `Verb`: `doc.verbs().toInfinitive().text()`
3. If tagged `Noun`: `doc.nouns().toSingular().text()`
4. If tagged `Adjective`: first adjective from `doc.adjectives().conjugate()`
5. Unconditional extra attempts:
   - `doc.verbs().toInfinitive().text()`
   - `doc.nouns().toSingular().text()`
6. Original normalized token

All candidates are:

- Normalized (`lowercase`, apostrophe normalization)
- Filtered by `WORD_TOKEN_RE = /^[A-Za-z]+(?:['’][A-Za-z]+)?$/`
- Deduplicated while preserving order (`orderedUnique`)

#### 2.2.2 Contextual Selection (`contextualDeinflectTaggedTerms`)

For each token:

1. Compute proper noun flag (details in section 5)
2. If proper noun and proper exclusion enabled:
   - Emit empty token `""`
3. Else:
   - Build candidate list
   - Pick first candidate where `lowerToIdx.has(candidate)` (model-vocabulary-aware)
   - Fallback chain: first candidate, then original normalized token

Output:

- `tokens`: model-aligned lemmas or `""` when filtered
- `properFlags`: boolean per original token

This is used for:

- Chapter/paragraph unknown-word detection
- Scope recommendation analysis

#### 2.2.3 Lemma Asset

- File: `site/data/lemma_dict.json` (current build includes ~2.7k mappings)
- Loaded once by `loadLemmaDict()`
- If load fails, runtime continues with compromise-only + identity fallback

---

## 3. Grouped Residual IRT for Word Knowledge Prediction (Small Observed Set)

### 3.1 Summary

Important distinction:

- Offline model fitting/export uses grouped residual IRT (`Response12GroupedResidualIRTEstimator`)
- Browser runtime currently performs a Rasch-style online update using exported per-word prior probabilities (`accuracy`) from that grouped model

So the site uses grouped-residual model outputs, but online personalization is intentionally lightweight and deterministic.

Dependencies:

- Offline training/export:
  - `numpy`, `pandas`, `scipy`, `scikit-learn`
  - `src/vocab_benchmark/estimators/irt.py`
  - `scripts/export_site_models.py`
- Runtime inference:
  - Plain JS math in `site/app.js`

### 3.2 Technical Specification

#### 3.2.1 Offline Grouped-Residual Estimator (Export Source)

Model key: `best_grouped_irt_model`, built by `build_estimator()` in `scripts/vocab_book_cli.py` with:

- `tau_theta = 2.0`
- `tau_delta = 1.6`
- `gate_c = 12.0`
- `n_groups = 12`
- `threshold_min = 0.10`
- `threshold_max = 0.90`
- `threshold_step = 0.005`
- `threshold_shrink_c = 30.0`
- `use_accuracy_difficulty = True`

Estimator internals (`Response12GroupedResidualIRTEstimator`):

1. Difficulty initialization:
   - Load accuracy priors per word
   - Convert to difficulty: `b_raw = -log(p/(1-p))`
   - Z-score normalize across observed items
2. Build dense user-item label matrix:
   - Missing labels imputed by item-majority class
3. Construct response12 group assignment matrix `Q`:
   - Cluster item response vectors with KMeans (`n_groups`)
   - Normalize vectors + centers
   - Similarity matrix `sim = x_norm @ centers^T`
   - Per item: take top-3 groups, softmax on scaled similarities (`* 6.0`), force top group prob >= 0.5, renormalize
4. User update objective:
   - Logit: `z = theta - b_i + gate * (Q_i · delta)`
   - `gate = n_obs / (n_obs + gate_c)`
   - Weighted Bernoulli NLL + Gaussian priors on `theta` and `delta`
   - Optimize with L-BFGS-B
5. Predict probability:
   - `p_i = sigmoid(theta - b_i + gate * (Q_i · delta))`

Formal objective used during grouped-estimator user-state updates:

- Let observed item set be `I`, labels `y_i ∈ {0,1}`, scalar `theta`, residual vector `delta ∈ R^G`.
- Per-item logit:
  - `z_i = theta - b_i + gate * (Q_i · delta)`
  - `gate = |I| / (|I| + gate_c)`
- Predicted probability:
  - `p_i = sigmoid(z_i)`
- Class-balanced sample weights:
  - `pos_rate = clip(mean(y), 0.05, 0.95)`
  - `w_pos = 0.5 / pos_rate`
  - `w_neg = 0.5 / (1 - pos_rate)`
  - `w_i = w_pos if y_i=1 else w_neg`
- Penalized objective:
  - `L(theta, delta) = -Σ_{i∈I} w_i [ y_i log(p_i) + (1-y_i) log(1-p_i) ] + theta^2/(2*tau_theta^2) + ||delta||^2/(2*tau_delta^2)`
- Optimization details:
  - optimizer: L-BFGS-B (`scipy.optimize.minimize`)
  - `maxiter=200`, `ftol=1e-9`
  - initialization: bounded scalar theta fit on `[-6, 6]` + previous delta (or zeros)

Runtime source file:

- `data/words.csv`
- Required columns:
  - `word`: lemma/token string
  - `accuracy`: probability in `[0, 1]`

Hard invariants:

1. `len(words) == len(accuracy)` after CSV parsing.
2. Runtime vocabulary map is `wordToIdx = Map(words[i] -> i)`.
3. Quiz candidate pool is the full parsed vocabulary in CSV order.

#### 3.2.2 Runtime Personalized Inference in Browser

Runtime model load (`loadVocabularyModel`):

1. Load and parse `data/words.csv`
2. Convert to per-word difficulty:
   - `b_i = -logit(clip(accuracy_i, 1e-6, 1-1e-6))`
3. Build `wordToIdx` map

User-knowledge update (`estimateTheta`):

- Scalar `theta` only (Rasch-style)
- MAP with Gaussian prior variance `25.0`
- Newton updates for 20 steps:
  - `grad = Σ(y_i - p_i) - theta/priorVar`
  - `hess = -Σ(p_i(1-p_i)) - 1/priorVar`
  - `theta <- theta - grad/hess`
  - `p_i = sigmoid(theta - b_i)`

Word knowledge prediction:

- Unobserved: `p(word known) = sigmoid(theta - b_i)`
- Observed words are hard-overridden:
  - known => `p=1`
  - unknown => `p=0`

Unknown set:

- `unknown = {word | p < threshold}`
- threshold comes from profile setting, default `0.5`

#### 3.2.3 Required Assets and How to Obtain

Minimum for runtime:

- `data/words.csv`

To regenerate runtime vocabulary asset:

1. Update or replace `data/words.csv` with the target `word`/`accuracy` rows.
2. Run `pnpm run sync:data` (or any command that triggers `sync:data`) to mirror into `public/data/`.

Additional algorithmic asset contracts:

- `data/lemma_dict.json`:
  - JSON object map `{ inflected_lower_word: lemma_lower_word }`
  - if missing/unreadable, runtime uses `{}`.
- `data/lexicon/index.json` + `data/lexicon/*.json`:
  - index shape: `{ bucket_key: file_name }`
  - each chunk file shape: array of `{ word: string, ipa: string, pos: string, definition: string }`.

---

## 4. Quiz Construction Algorithm (`adaptive_uncertainty_light_random`)

### 4.1 Summary

Canonical definition for this section is the Python CLI adaptive strategy:

- policy name: `adaptive_uncertainty_light_random`
- implementation: `StochasticTopKUncertaintyPolicy(top_k=3, temperature=0.03)`
- selection is sequential and stateful (one word at a time, then user-state update, then next selection)

Dependencies:

- CLI orchestration in `scripts/vocab_book_cli.py`
- policy in `src/vocab_benchmark/query_policies.py`
- estimator-specific `predict_uncertainty` and `update_user_state`

### 4.2 Technical Specification

#### 4.2.1 Candidate Pool and Constraints

In adaptive CLI flow:

1. `candidate_word_ids` is built from `responses_static` support:
   - `sorted(unique(response_frame["word_idx"]))`
2. At each step, already-queried IDs are excluded.
3. Quiz length is the requested `quiz_size` (no `[20,200]` clamp in this path).

#### 4.2.2 Uncertainty Scoring

At each step, policy computes:

1. `uncertainty = estimator.predict_uncertainty(user_state, pool)`
2. take top-`k` uncertain candidates (`k=3`)
3. sample one by temperature-softmax over those uncertainty values (`T=0.03`)

#### 4.2.3 Light Randomization Sampler

Constants:

- `topK = 3`
- `temperature = 0.03`

Policy step (`batch_size=1` in CLI usage):

1. `pool = candidates \ already_queried`
2. `cand = argsort_desc(uncertainty(pool))[:min(topK, len(pool))]`
3. `logits = uncertainty[cand] / T`
4. normalize with:
   - `logits -= max(logits)`
   - `probs = exp(clip(logits, -60, 60))`
   - `probs /= max(sum(probs), 1e-12)`
5. sample index via `rng.choice(cand, p=probs)`
6. return selected word ID.

#### 4.2.4 RNG and Seed Determinism

Adaptive CLI uses:

- RNG: `numpy.random.default_rng(seed)`
- The sequence depends on:
  - seed,
  - estimator state trajectory,
  - user answers (because each answer updates state before next pick).

#### 4.2.5 Parity Guarantee

Important distinction:

- `adaptive_uncertainty_light_random` (CLI strategy) is sequential estimator-driven.
- `adaptive_uncertainty_light_random_site_words` is a site-parity helper with a simplified Rasch-from-accuracy approximation and JS-compatible LCG.

Current repository parity tests validate helper parity, not full adaptive-policy parity:

- Site JS strategy execution (`tests/site_app_quiz_strategy_checks.cjs`)
- Python reference (`adaptive_uncertainty_light_random_site_words` in `scripts/vocab_book_cli.py`)

for multiple observed-answer sets and seeds.

Deterministic fixtures below therefore correspond to `adaptive_uncertainty_light_random_site_words`:

1. `seed=42`, `quiz_size=20`, `observed={}`
   - `["remainder","recipient","volcanic","soften","peel","dose","significance","carelessly","bizarre","unloved","storytelling","drown","articulate","saturation","rap","desperation","hypnosis","whom","loudspeaker","commitment"]`
2. `seed=12345`, `quiz_size=20`, `observed={"the":1,"and":1,"because":1,"zygote":0}`
   - `["tarry","beget","purport","alderman","acreage","teem","tawdry","rescind","hackneyed","dour","quaver","bemoan","abhor","presage","wean","warble","asunder","crony","variegated","romp"]`
3. `seed=314159265`, `quiz_size=20`, `observed={"apple":1,"banana":1,"Wednesday":1,"xylophone":0,"henceforth":0}`
   - `["beget","tarry","teem","tawdry","purport","acreage","quaver","doldrums","rescind","alderman","warble","hackneyed","dour","variegated","abhor","bemoan","astern","presage","romp","wean"]`

---

## 5. Proper Noun Detection

### 5.1 Summary

Proper noun filtering is conservative and two-stage:

- Token-level heuristic/tag detection
- High-confidence lexicon induction from the current text scope to reduce false positives from sentence-initial capitalization

Dependencies:

- `compromise` term tags (when available)
- Regex/token-shape heuristics
- Curated exclusion sets for calendar/time words and common title-case noise words

### 5.2 Technical Specification

#### 5.2.1 Token-Level Predicate (`isProperNounTag`)

A token is considered proper at tag stage if:

1. It has one of compromise proper tags:
   - `ProperNoun`, `Person`, `Place`, `City`, `Country`, `Organization`, etc.
2. Or it passes fallback shape heuristics:
   - matches word token regex
   - starts with uppercase
   - not all-uppercase
   - not in calendar exclusions (`monday`, `january`, etc.)
   - not in title-case noise set (`the`, `and`, `this`, etc.)
   - sentence-initial short token (`len<=2`) is rejected

`isNameLikeToken` applies similar casing filters and exclusions for stronger name evidence.

#### 5.2.2 High-Confidence Lexicon Induction (`buildHighConfidenceProperNounLexicon`)

For each normalized token across tagged sentences, aggregate:

- `total`
- `proper`
- `sentenceInitialProper`
- `lowercaseSeen`
- `nameLikeProper`

Token enters high-confidence proper lexicon iff all pass:

- not calendar excluded
- `proper >= 2`
- `proper/total >= 0.60`
- `nameLikeProper >= 2`
- `lowercaseSeen == 0`
- not only sentence-initial proper with low evidence:
  - reject if `sentenceInitialProper == proper` and `proper < 5`

This lexicon is built per analysis scope/chapter and used to gate exclusion.

#### 5.2.3 Integration with Deinflection

In `contextualDeinflectTaggedTerms`:

- `properByLexicon = tagProper && properLexicon.has(token)` when lexicon provided
- Only then can token be zeroed out (if exclusion enabled)

This prevents over-filtering from naive capitalization.

---

## 6. Other Important Algorithmic Decisions

## 6.1 Paragraph Assistance Card Selection

### 6.1.1 Summary

Per paragraph, only top unknown words are surfaced to avoid overload:

- Desktop: max 3 words
- Mobile: max 2 words

### 6.1.2 Technical Specification

For each paragraph unknown word:

- local frequency in paragraph
- uncertainty proxy normalized by threshold:
  - `uncertaintyScore = (1 - p_known)/(1 - threshold)`
- importance:
  - `importance = 0.7*freq + 0.3*uncertaintyScore`

Top-N by importance become cards and highlights.

Priority visual marker:

- mark token as priority if `p_unknown > 0.60`.

## 6.2 Lexicon/Definition Asset Construction

### 6.2.1 Summary

Word definition cards use static lexicon artifacts built offline.

### 6.2.2 Technical Specification

Script: `scripts/build-lexicon-from-wiktextract.mjs`

1. Read vocabulary from `data/words.csv`
2. Optional overrides from `data/lexicon_overrides.json`
3. Ensure local archive `downloads/raw-wiktextract-data.jsonl.gz`:
   - if missing, download from `https://kaikki.org/dictionary/raw-wiktextract-data.jsonl.gz`
   - if present, reuse local archive
4. Reuse any already bundled entries from existing chunk files referenced by `data/lexicon/index.json`
5. Fallbacks:
   - definition: `"Definition unavailable in this build."`
   - IPA: empty string
6. Emit:
   - chunked files `data/lexicon/{a..z,_.json}` + `index.json`

Runtime load strategy:

- Load chunk index, then load all referenced chunk files.

Dependency note:

- Archive source URL is fixed to `https://kaikki.org/dictionary/raw-wiktextract-data.jsonl.gz`.

## 6.3 Persistent Storage and Static-Only Runtime

### 6.3.1 Summary

State persistence is client-only:

- Profiles/settings/quiz observations in `localStorage`
- Imported books in `IndexedDB` (`vocab_reader_books_v1`) with `localStorage` fallback

### 6.3.2 Technical Specification

This design is algorithmically relevant because:

- Quiz candidate filtering excludes already observed words from persisted profile state
- Unknown-set prediction is driven entirely by stored observed labels + static model priors
- No server calls are used for personalization, keeping behavior deterministic per local data

---

## 7. Reproducibility Checklist (Assets + Validation)

1. Prepare processed dataset (`docs/data_preparation.md`).
2. Export site models:
   - `.venv/bin/python scripts/export_site_models.py`
3. Build lexicon:
   - `.venv/bin/python scripts/build_site_lexicon.py`
4. Run parity/context checks:
   - `node tests/site_app_contextual_checks.cjs`
   - `.venv/bin/pytest tests/test_site_app_contextual.py tests/test_site_quiz_strategy_parity.py -q`

This reproduces the core algorithmic assets currently consumed by `site/app.js`.

---

## 8. Numerical Stability and Determinism Conventions

These conventions are part of algorithm behavior and should be treated as spec requirements.

1. Probability clipping:
   - `clip01(p) = min(1-1e-6, max(1e-6, p))`
   - used before logit transforms and when loading model probabilities.
2. Difficulty transform:
   - `b = -logit(p)` with clipped `p`.
3. Runtime Newton update guard:
   - break if `|hessian| < 1e-8`.
4. Quiz softmax stabilization:
   - subtract max score before exponentiation.
   - clamp logits to `[-60, 60]`.
5. RNG:
   - for CLI adaptive policy: `numpy.random.default_rng(seed)`.
   - the LCG (`1664525`, `1013904223`, `2^32`) applies only to `adaptive_uncertainty_light_random_site_words`.
6. Sorting/tie contracts:
   - CLI adaptive policy ranks by uncertainty descending inside each step (`np.argsort(-uncertainty)`), then samples from top-k via softmax.
   - helper `adaptive_uncertainty_light_random_site_words` uses explicit stable tie-break by original candidate position.
7. Observation override:
   - hard `{1.0, 0.0}` overrides apply to site reader inference logic, not to CLI adaptive policy selection.

---

## 9. Canonical Non-UI Algorithm Test Vectors

These vectors are intended for independent parity checks beyond quiz generation.

### 9.1 Proper-Noun + Exclusion Vector

Input tagged sentences:

- sentence 1: `Arthur/ProperNoun`, `Dent/ProperNoun`
- sentence 2: `He`, `met`, `Dent/ProperNoun`
- sentence 3: `Again`, `Dent/ProperNoun`
- sentence 4: `Monday/ProperNoun`, `arrived`
- sentence 5: `Monday/ProperNoun`, `left`

Expected `buildHighConfidenceProperNounLexicon(...)`:

- contains `"dent"`: `true`
- contains `"monday"`: `false`

### 9.2 Contextual Deinflection Vector

Given:

- `lemmaDict = { "running": "run", "dogs": "dog" }`
- tagged terms:
  - `running` tagged Verb
  - `dogs` tagged Noun
  - `Dent` tagged ProperNoun
- `lowerToIdx = {"run","dog","dent"}`
- `properNounLexicon = {"dent"}`
- `excludeProperNouns = true`

Expected:

- `tokens = ["run", "dog", ""]`
- `properFlags = [false, false, true]`
