"""Build a WordNet-card pilot from the existing lemma-disjoint reader contexts."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "wsd" / "data" / "processed" / "reader-filter-dev-v1.jsonl"
OUTPUT = ROOT / "wsd" / "data" / "reader-wordnet-filter-pilot-draft.jsonl"
LIMITS = {"calibration": 25, "evaluation": 17}


def fnv_bucket(word: str) -> int:
    value = 2166136261
    for byte in word.encode("utf-8"):
        value = ((value ^ byte) * 16777619) & 0xFFFFFFFF
    return value % 1024


def wordnet_entry(word: str, cache: dict[int, dict[str, dict]]) -> dict | None:
    bucket = fnv_bucket(word)
    if bucket not in cache:
        path = ROOT / "data" / "wordnet" / f"{bucket:04d}.json"
        cache[bucket] = {
            entry["word"]: entry
            for entry in json.loads(path.read_text(encoding="utf-8"))
        }
    return cache[bucket].get(word)


def main() -> None:
    cache: dict[int, dict[str, dict]] = {}
    selected: list[dict] = []
    split_counts = {split: 0 for split in LIMITS}
    for line in SOURCE.read_text(encoding="utf-8").splitlines():
        source = json.loads(line)
        split = source["benchmark_split"]
        if split_counts[split] >= LIMITS[split]:
            continue
        lookup_word = source["lookup_word"].lower()
        entry = wordnet_entry(lookup_word, cache)
        if entry is None:
            entry = wordnet_entry(source["lemma"].lower(), cache)
        if entry is None:
            continue
        definitions = [
            definition
            for sense in entry["senses"]
            if sense["partOfSpeech"] == source["pos"]
            for definition in sense["definitions"]
        ]
        if len(definitions) < 6:
            continue
        candidates = [
            {
                "sense_id": definition["id"],
                "part_of_speech": source["pos"],
                "gloss": definition["gloss"],
                "original_rank": index,
            }
            for index, definition in enumerate(definitions)
        ]
        selected.append({
            "id": source["id"].replace("reader-filter-dev-v1", "reader-wordnet-filter-pilot"),
            "dataset": "reader-wordnet-filter-pilot",
            "benchmark_split": split,
            "source": source["source"],
            "context": source["context"],
            "target": source["target"],
            "target_start": source["target_start"],
            "lookup_word": entry["word"],
            "lemma": source["lemma"],
            "pos": source["pos"],
            "candidates": candidates,
            "annotation_status": "unreviewed",
        })
        split_counts[split] += 1
    if split_counts != LIMITS:
        raise ValueError(f"Could not fill WordNet pilot splits: actual={split_counts} expected={LIMITS}")
    OUTPUT.write_text(
        "".join(json.dumps(example, ensure_ascii=True) + "\n" for example in selected),
        encoding="utf-8",
    )
    print(f"wrote {len(selected)} WordNet-card examples: {split_counts}")


if __name__ == "__main__":
    main()
