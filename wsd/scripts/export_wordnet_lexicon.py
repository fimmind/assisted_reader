from __future__ import annotations

import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path

from nltk.corpus.reader.wordnet import WordNetCorpusReader
from nltk.data import ZipFilePathPointer


WORD_PATTERN = re.compile(r"^[a-z]+(?:'[a-z]+)?(?:-[a-z]+(?:'[a-z]+)?)*$")
BUCKET_COUNT = 1024
SCHEMA_VERSION = 1
POS_NAMES = {"n": "noun", "v": "verb", "a": "adjective", "s": "adjective", "r": "adverb"}


def normalize_word(word: str) -> str:
    return word.lower().replace("_", " ").replace("’", "'").replace("‐", "-").replace("‑", "-")


def hash_word(word: str) -> int:
    result = 2166136261
    for character in word:
        result ^= ord(character)
        result = (result * 16777619) & 0xFFFFFFFF
    return result


def source_words(lexicon_dir: Path) -> set[str]:
    """Require a complete source lexicon so missing buckets cannot remove aliases."""
    index_path = lexicon_dir / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    if (
        not isinstance(index, dict)
        or index.get("schemaVersion") != 5
        or index.get("bucketAlgorithm") != "fnv1a-32"
        or index.get("bucketCount") != BUCKET_COUNT
        or type(index.get("entryCount")) is not int
        or index["entryCount"] <= 0
    ):
        raise ValueError(f"Invalid Wiktionary index: {index_path}")
    words: set[str] = set()
    entry_count = 0
    for bucket_id in range(BUCKET_COUNT):
        path = lexicon_dir / f"{bucket_id:04d}.json"
        with path.open(encoding="utf-8") as source:
            entries: list[dict[str, object]] = json.load(source)
        if not isinstance(entries, list):
            raise ValueError(f"Invalid Wiktionary bucket: {path}")
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("word"), str):
                raise ValueError(f"Invalid Wiktionary entry: {path}")
            word = entry.get("word")
            if isinstance(word, str):
                if hash_word(word) % BUCKET_COUNT != bucket_id:
                    raise ValueError(f"Wiktionary headword in wrong bucket: word={word} file={path}")
                normalized = normalize_word(word)
                if WORD_PATTERN.fullmatch(normalized):
                    words.add(normalized)
            entry_count += 1
    if entry_count != index["entryCount"]:
        raise ValueError(f"Wiktionary entry count mismatch: expected={index['entryCount']} actual={entry_count}")
    if not words:
        raise ValueError(f"No Wiktionary headwords found in {lexicon_dir}")
    return words


def wordnet_entry(word: str, wordnet: WordNetCorpusReader) -> dict[str, object] | None:
    """Keep WordNet's order, counting synsets reached through multiple lemmas once."""
    groups: dict[str, list[dict[str, str]]] = {}
    seen_ids: set[str] = set()
    for synset in wordnet.synsets(word):
        if synset.name() in seen_ids:
            continue
        seen_ids.add(synset.name())
        part_of_speech = POS_NAMES[synset.pos()]
        senses = groups.setdefault(part_of_speech, [])
        senses.append({"id": synset.name(), "gloss": synset.definition()})
    if not groups:
        return None
    return {
        "word": word,
        "senses": [
            {"partOfSpeech": part_of_speech, "definitions": senses}
            for part_of_speech, senses in groups.items()
        ],
    }


def export_assets(wordnet_archive: Path, lexicon_dir: Path, output_dir: Path) -> None:
    if output_dir.resolve() == lexicon_dir.resolve():
        raise ValueError("WordNet output must not overwrite the Wiktionary lexicon.")
    if not wordnet_archive.is_file():
        raise FileNotFoundError(f"WordNet archive is missing: {wordnet_archive}")
    wordnet = WordNetCorpusReader(ZipFilePathPointer(str(wordnet_archive), "wordnet/"), None)
    if wordnet.get_version() != "3.0":
        raise ValueError(f"Expected WordNet 3.0, got {wordnet.get_version()}")

    all_words = {
        normalized
        for name in wordnet.all_lemma_names()
        if WORD_PATTERN.fullmatch(normalized := normalize_word(name))
    }
    all_words.update(source_words(lexicon_dir))
    buckets: list[list[dict[str, object]]] = [[] for _ in range(BUCKET_COUNT)]
    entry_count = 0
    for index, word in enumerate(sorted(all_words), start=1):
        entry = wordnet_entry(word, wordnet)
        if entry is not None:
            buckets[hash_word(word) % BUCKET_COUNT].append(entry)
            entry_count += 1
        if index % 100000 == 0:
            print(f"wordnet-export-progress checked={index} entries={entry_count}", flush=True)

    output_dir.mkdir(parents=True, exist_ok=True)
    for bucket_id, entries in enumerate(buckets):
        path = output_dir / f"{bucket_id:04d}.json"
        path.write_text(json.dumps(entries, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    with zipfile.ZipFile(wordnet_archive) as archive:
        license_text = archive.read("wordnet/LICENSE")
    (output_dir / "LICENSE").write_bytes(license_text)
    index = {
        "schemaVersion": SCHEMA_VERSION,
        "wordnetVersion": "3.0",
        "bucketAlgorithm": "fnv1a-32",
        "bucketCount": BUCKET_COUNT,
        "entryCount": entry_count,
        "sourceSha256": hashlib.sha256(wordnet_archive.read_bytes()).hexdigest(),
    }
    (output_dir / "index.json").write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")
    print(f"wordnet-export-complete entries={entry_count} buckets={BUCKET_COUNT}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wordnet-archive", type=Path, required=True)
    parser.add_argument("--wiktionary-lexicon", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    export_assets(args.wordnet_archive, args.wiktionary_lexicon, args.output)


if __name__ == "__main__":
    main()
