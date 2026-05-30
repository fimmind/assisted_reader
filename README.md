# Assisted Reader

Assisted Reader is a Vite + React web app for reading books with vocabulary assistance:

- per-paragraph unknown word detection
- contextual deinflection and proper noun filtering
- inline highlighting and definition cards
- library and quiz flows

This README covers setup, build/run/deploy, and project structure.

## Requirements

- Node.js 20+ (recommended)
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
    - `lexicon.ts` — lexicon index/chunk loading with resilience
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

Definition entries are sourced from **Wiktionary** via **Wiktextract** exports.

- Runtime files consumed by the app:
  - `data/lexicon/index.json`
  - `data/lexicon/*.json`
- Build script:
  - `scripts/build-lexicon-from-wiktextract.mjs`
- Rebuild command:
  - `pnpm run build:lexicon:wiktextract`

`pnpm run build` and `pnpm run deploy` automatically run `ensure:lexicon`, which generates chunked lexicon files if they are missing.

The script auto-downloads the Wiktextract archive from [kaikki.org](https://kaikki.org/dictionary/raw-wiktextract-data.jsonl.gz) into `downloads/` when missing, and reuses it when already present.

The builder matches entries to words from `data/words.csv`, prefers English (`lang_code = "en"`), and falls back to `"Definition unavailable in this build."` when no usable definition is found.

Generated lexicon entry behavior:

- up to 2 bundled definitions per word (`definitions`), with near-identical inflection glosses filtered out
- separate pronunciation fields for US/UK variants when available (`ipaUs`, `ipaUk`)
- compatibility fields (`definition`, `ipa`) retained for runtime fallback

Runtime display behavior:

- Settings include **English Variant** (`US` or `UK`)
- definition cards select pronunciation by that variant (`ipaUs`/`ipaUk`) with fallback when one variant is missing
- the same setting path is intended to influence definitions in future work

These assets must exist in `public/data/` for runtime fetches. `sync:data` handles this.

### Deploy bundling guarantee

`pnpm run verify:deploy-assets` validates that deploy output (`dist/`) includes:

- `data/lexicon/index.json`
- every chunk file referenced by `index.json`

and performs schema sanity checks on sampled chunk entries to ensure definitions are present.

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
