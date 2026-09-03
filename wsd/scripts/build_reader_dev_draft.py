from __future__ import annotations

import json
import re
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "wsd" / "data" / "reader-dev-v1-draft.jsonl"
BASE_URL = "https://fimmind.github.io/assisted_reader/data/lexicon"
MAX_EXAMPLES = 100
MIN_CANDIDATES = 3
MAX_CANDIDATES = 20
MAX_CONTEXT_CHARS = 360
CONTEXTUAL_POS = {
    ("hitchhikers_guide.txt", "watches"): "noun",
    ("hitchhikers_guide.txt", "change"): "noun",
    ("hitchhikers_guide.txt", "letters"): "noun",
    ("hitchhikers_guide.txt", "interesting"): "adjective",
    ("hitchhikers_guide.txt", "name"): "noun",
    ("hitchhikers_guide.txt", "kind"): "noun",
    ("hitchhikers_guide.txt", "company"): "noun",
    ("hitchhikers_guide.txt", "contents"): "noun",
    ("hitchhikers_guide.txt", "subject"): "noun",
    ("hitchhikers_guide.txt", "project"): "noun",
    ("hitchhikers_guide.txt", "motioned"): "verb",
    ("hitchhikers_guide.txt", "palm"): "noun",
    ("hitchhikers_guide.txt", "rule"): "noun",
    ("hitchhikers_guide.txt", "current"): "adjective",
    ("hitchhikers_guide.txt", "model"): "noun",
    ("hitchhikers_guide.txt", "objects"): "noun",
    ("AiW.txt", "project"): "noun",
    ("AiW.txt", "contents"): "noun",
    ("AiW.txt", "name"): "noun",
    ("AiW.txt", "row"): "noun",
    ("AiW.txt", "kind"): "adjective",
    ("AiW.txt", "changed"): "verb",
    ("AiW.txt", "subject"): "noun",
    ("AiW.txt", "interesting"): "adjective",
    ("AiW.txt", "letter"): "noun",
    ("AiW.txt", "watch"): "noun",
    ("AiW.txt", "rule"): "noun",
    ("AiW.txt", "company"): "noun",
    ("AiW.txt", "current"): "adjective",
}
CANDIDATE_LEMMAS = {
    "arm", "bank", "bar", "base", "board", "body", "book", "bound", "case", "change", "charge", "club", "company", "content",
    "court", "cover", "crane", "cross", "current", "date", "deck", "draft", "face", "fall", "figure", "file", "fine", "fly",
    "form", "game", "ground", "hand", "head", "hold", "interest", "issue", "kind", "last", "letter", "light", "line", "mark",
    "mean", "mine", "model", "motion", "mouth", "name", "note", "object", "order", "page", "palm", "paper", "part", "pass",
    "pitch", "play", "point", "pool", "port", "present", "press", "project", "quarter", "race", "range", "right", "ring", "rock",
    "round", "row", "rule", "scale", "seal", "second", "set", "shift", "ship", "show", "spring", "square", "stage", "state",
    "subject", "table", "term", "tie", "train", "trunk", "turn", "watch", "wave", "well", "yard",
}


def hash_word(word: str) -> int:
    value = 2166136261
    for char in word:
        value ^= ord(char)
        value = (value * 16777619) & 0xFFFFFFFF
    return value


def get_json(url: str) -> list[dict]:
    with urllib.request.urlopen(url) as response:
        return json.load(response)


def candidates(entry: dict) -> list[dict]:
    return [
        {
            "sense_id": f"{entry['word']}.{sense['partOfSpeech']}.{index + 1}",
            "part_of_speech": sense["partOfSpeech"],
            "gloss": gloss,
            "relevance": "needs_review",
        }
        for sense in entry["senses"]
        for index, gloss in enumerate(sense["definitions"])
    ]


def main() -> None:
    lemma_map = json.loads((ROOT / "data" / "lemma_dict.json").read_text(encoding="utf-8"))
    bucket_words: dict[int, list[str]] = defaultdict(list)
    for lemma in CANDIDATE_LEMMAS:
        bucket_words[hash_word(lemma) % 1024].append(lemma)
    entries: dict[str, dict] = {}
    for bucket, words in bucket_words.items():
        wanted = set(words)
        for entry in get_json(f"{BASE_URL}/{bucket:04}.json"):
            if entry["word"] in wanted:
                entries[entry["word"]] = entry
    exact_entries: dict[str, dict] = {}

    def lookup_exact(word: str) -> dict | None:
        if word in exact_entries:
            return exact_entries[word]
        bucket = hash_word(word) % 1024
        for entry in get_json(f"{BASE_URL}/{bucket:04}.json"):
            if entry["word"] == word:
                exact_entries[word] = entry
                return entry
        return None
    selected = {
        lemma for lemma, entry in entries.items()
        if MIN_CANDIDATES <= len(candidates(entry)) <= MAX_CANDIDATES
    }
    examples: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for filename in ("hitchhikers_guide.txt", "AiW.txt"):
        text = (ROOT / "data" / filename).read_text(encoding="utf-8")
        for sentence in re.findall(r"[^.!?]+[.!?]+", re.sub(r"\s+", " ", text)):
            if len(sentence.strip()) > MAX_CONTEXT_CHARS:
                continue
            for word in re.findall(r"[a-z]+(?:'[a-z]+)?", sentence.lower()):
                lemma = lemma_map.get(word, word)
                key = (filename, lemma)
                if lemma not in selected or key in seen:
                    continue
                displayed_entry = lookup_exact(word) or entries[lemma]
                examples.append({
                    "id": f"reader-dev-draft-{len(examples) + 1}", "dataset": "reader-dev-v1-draft",
                    "source": {"file": f"data/{filename}", "sentence": sentence.strip()},
                    "context": sentence.strip(), "target": word, "lemma": lemma,
                    "lookup_word": displayed_entry["word"],
                    "pos": CONTEXTUAL_POS.get((filename, word)),
                    "candidates": candidates(displayed_entry), "review_status": "needs_annotation",
                })
                seen.add(key)
                if len(examples) == MAX_EXAMPLES:
                    break
            if len(examples) == MAX_EXAMPLES:
                break
        if len(examples) == MAX_EXAMPLES:
            break
    OUTPUT.write_text("".join(json.dumps(example, ensure_ascii=True) + "\n" for example in examples), encoding="utf-8")
    print(json.dumps({"output": str(OUTPUT.relative_to(ROOT)), "examples": len(examples), "ambiguous_lemmas": len(selected)}))


if __name__ == "__main__":
    main()
