# Assisted Reader

Assisted Reader is a Vite + React web app for reading books with vocabulary assistance:

- per-paragraph unknown word detection
- contextual deinflection and proper noun filtering
- inline highlighting and definition cards
- library and quiz flows

This README covers setup, build/run/deploy, and project structure.

## Importing books

Use **Import Book** in the library to select TXT, EPUB, or PDF files. PDF text
is extracted locally in the browser with PDF.js; no file is uploaded and the
original PDF is not stored. All pages are imported as one chapter in the normal
book store and use the existing vocabulary assistance. Paragraphs stay in page
order, with a paragraph break at each page boundary; empty pages are skipped.

PDF import joins wrapped lines and hyphenated line breaks, and uses line gaps
and indentation to retain paragraph boundaries. It is intended for simple
single-column text. Scanned PDFs without selectable text, OCR, images, tables,
and reconstruction of complex layouts are not supported.

## Requirements

- Node.js 22.13+ or 24+ (required by PDF.js)
- `pnpm` (required by repository policy)

## Install

```bash
pnpm install
```

## Run locally

```bash
pnpm dev
```

Notes:

- `pnpm dev` runs `predev`, which copies runtime data assets from `data/` to `public/data/`.
- Default dev host is `0.0.0.0`.

## Build

```bash
pnpm build
```

Build includes:

1. `pnpm run sync:data`
2. TypeScript check (`pnpm run typecheck`)
3. Vite production build to `dist/`

Preview production build:

```bash
pnpm serve
```

## Tests

Typecheck:

```bash
pnpm run typecheck
```

Proper noun + deinflection test suite:

```bash
pnpm run test:proper-nouns
```

## Deploy to GitHub Pages

Repository is configured for project pages:

- homepage: `https://fimmind.github.io/assisted_reader`
- base path for build: `/assisted_reader/`

Deploy command:

```bash
pnpm run deploy
```

What deploy does:

1. Build with `BASE_PATH=/assisted_reader/`
2. Create `dist/.nojekyll`
3. Verify required deploy assets (`pnpm run verify:deploy-assets`)
4. Publish `dist/` to `gh-pages` branch via `gh-pages -d dist --nojekyll`

## Project structure

Top-level:

- `src/` — application source code
- `data/` — runtime model/book/lexicon assets
- `public/` — static files copied/served by Vite
- `tests/` — Node-based test files
- `scripts/verify-deploy-assets.mjs` — deploy asset validator
- `spec.md` — product behavior spec
- `site_algorithms.md` — algorithm reference/source of truth

`src/` layout:

- `src/pages/`
  - route-level screens (`LibraryPage`, `ReaderPage`, `SettingsPage`)
- `src/components/`
  - reusable UI and domain components (`BookCard`, `WordDefinitionCard`, `QuizModal`, etc.)
  - `src/components/ui/` contains design-system primitives
- `src/core/`
  - core logic, storage, NLP, and model integration
  - key modules:
    - `reader-analysis.ts` — chapter/paragraph analysis and unknown-word stats
    - `nlp.ts` — tokenization, proper noun handling, contextual deinflection
    - `model.ts` — vocabulary model loading + probability estimation
    - `lexicon.ts` — cached, on-demand lexicon bucket lookup
    - `books-store.ts` — IndexedDB/local fallback storage for imported books
    - `profile-store.ts` — profile/settings persistence + events
    - `external.ts` — external runtime integrations (e.g. compromise, JSZip)
- `src/hooks/` — React hooks (e.g. settings)
- `src/lib/` — helper utilities
- `src/data/` — mock/static in-app data where applicable
- `src/assets/` — bundled image/media assets

## Data assets

The app depends on files under `data/`, including:

- vocabulary Rasch source CSV (`words.csv` with `word` + `accuracy`)
- lemma dictionary
- lexicon index + chunk files
- seeded default book text

### Lexicon source

Definition entries are sourced from **WordNet 3.0** when a matching part of speech is available. **Wiktionary** via **Wiktextract** supplies pronunciations and definitions for parts of speech absent from WordNet.

- Runtime files consumed by the app:
  - `data/lexicon/index.json`
  - `data/lexicon/*.json`
  - `data/wordnet/index.json`
  - `data/wordnet/*.json`
- Build script:
  - `scripts/build-lexicon-from-wiktextract.mjs`
- Rebuild command:
  - `pnpm run build:lexicon:wiktextract`

`pnpm run build` and `pnpm run deploy` automatically run `ensure:lexicon`, which generates chunked Wiktionary files if they are missing, and `verify:wordnet`, which rejects incomplete or malformed WordNet assets before copying data into the build.

The script auto-downloads the Wiktextract archive from [kaikki.org](https://kaikki.org/dictionary/raw-wiktextract-data.jsonl.gz) into `downloads/` when missing, and reuses it when already present.

The builder includes every English (`lang_code = "en"`) headword matching the reader's lookup grammar. Words from `data/words.csv` are also retained as empty fallback entries when Wiktextract has no usable definition. The existing Wiktionary assets remain separate and complete.

WordNet 3.0 senses are exported from the NLTK WordNet corpus by `wsd/scripts/export_wordnet_lexicon.py`. The checked-in `data/wordnet/` contains 1,024 on-demand buckets, an index, stable synset IDs, and the WordNet license. To regenerate it after building `data/lexicon/`, run:

```bash
uv run --project wsd python wsd/scripts/export_wordnet_lexicon.py --wordnet-archive /path/to/wordnet.zip --wiktionary-lexicon data/lexicon --output data/wordnet
```

Generated lexicon entry behavior:

- definitions are grouped by part of speech in each word's `senses` array
- deduplicated definitions per part of speech, with near-identical inflection glosses filtered out
- each part-of-speech group carries its own US/UK pronunciation fields when available
- entries are distributed across 1,024 deterministic hash buckets for on-demand lookup
- the lexicon index is schema-versioned so incompatible generated assets are rebuilt automatically

Runtime display behavior:

- Settings include **English Variant** (`US` or `UK`)
- definition cards select pronunciation by that variant (`ipaUs`/`ipaUk`) with fallback when one variant is missing
- WordNet definitions replace Wiktionary definitions for a matching part of speech; Wiktionary remains the source of transcription
- parts of speech absent from WordNet retain their Wiktionary definitions
- contextual POS inference selects the matching definition group for automatic cards, clicked words, and nested lookups
- when POS is unknown or unavailable in the lexicon, cards display all available groups with visible POS labels
- dictionary files are not fetched during reader startup; automatic and clicked cards fetch and cache only the required WordNet and Wiktionary buckets
- clicked words try their exact displayed form before falling back to the inferred lemma

These assets must exist in `public/data/` for runtime fetches. `sync:data` handles this.

### Deploy bundling guarantee

`pnpm run verify:deploy-assets` validates that deploy output (`dist/`) includes:

- `data/lexicon/index.json`
- `data/wordnet/index.json` and all WordNet buckets
- `data/wordnet/LICENSE`
- every deterministic bucket declared by `index.json`

and validates every bucket assignment, entry, POS group, and definition against the current schema. It also compares both dictionaries byte for byte with `data/`, including the WordNet license. The deployment command runs these checks before publishing.

## Useful commands

```bash
pnpm run sync:data
pnpm run build:lexicon:wiktextract
pnpm run typecheck
pnpm run test:proper-nouns
pnpm run build
pnpm run serve
pnpm run deploy
```
