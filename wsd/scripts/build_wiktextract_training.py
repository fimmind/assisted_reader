from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = ROOT.parent
ARCHIVE = REPOSITORY_ROOT / "downloads" / "raw-wiktextract-data.jsonl.gz"
VOCABULARY = REPOSITORY_ROOT / "data" / "words.csv"
OUTPUT = ROOT / "data" / "training" / "wiktextract-wsd-v1.jsonl"
OPEN_CLASS_POS = {
    "noun": "noun",
    "verb": "verb",
    "adj": "adjective",
    "adj_noun": "adjective",
    "adj_verb": "adjective",
    "adv": "adverb",
}
WORD_RE = re.compile(r"^[a-z]+(?:'[a-z]+)?(?:-[a-z]+(?:'[a-z]+)?)*$")


@dataclass(frozen=True)
class Example:
    text: str
    target: str


@dataclass(frozen=True)
class Sense:
    definitions: tuple[str, ...]
    examples: tuple[Example, ...]


def normalize_spaces(value: str) -> str:
    return " ".join(value.split())


def normalize_word(value: str) -> str:
    return value.strip().lower().replace("’", "'").replace("‐", "-").replace("‑", "-")


def normalized_gloss_identity(gloss: str) -> str:
    base = normalize_spaces(gloss).lower()
    while base.startswith("("):
        closing_index = base.find(")")
        if closing_index < 0:
            break
        base = normalize_spaces(base[closing_index + 1:])
    return normalize_spaces(re.sub(r"[^\w\s]", " ", base))


def primary_definitions(sense: dict) -> tuple[str, ...]:
    definitions: list[str] = []
    identities: set[str] = set()
    for field in ("glosses", "raw_glosses"):
        values = sense.get(field, [])
        if not isinstance(values, list):
            continue
        for value in values:
            if not isinstance(value, str):
                continue
            definition = normalize_spaces(value)
            identity = normalized_gloss_identity(definition)
            if definition and identity and identity not in identities:
                definitions.append(definition)
                identities.add(identity)
    return tuple(definitions)


def sense_examples(sense: dict) -> tuple[Example, ...]:
    output: list[Example] = []
    values = sense.get("examples", [])
    if not isinstance(values, list):
        return ()
    for value in values:
        if not isinstance(value, dict) or value.get("type") not in {"example", "quotation"}:
            continue
        text_value = value.get("text")
        offsets = value.get("bold_text_offsets")
        if not isinstance(text_value, str) or not isinstance(offsets, list) or not offsets:
            continue
        text = normalize_spaces(text_value)
        if len(text) < 20 or len(text) > 420:
            continue
        first_offset = offsets[0]
        if (
            not isinstance(first_offset, list)
            or len(first_offset) != 2
            or not all(isinstance(item, int) for item in first_offset)
        ):
            continue
        start, end = first_offset
        raw_text = text_value
        if start < 0 or end <= start or end > len(raw_text):
            continue
        target = normalize_spaces(raw_text[start:end])
        if not target:
            continue
        output.append(Example(text=text, target=target))
    return tuple(output)


def load_vocabulary() -> set[str]:
    with VOCABULARY.open(newline="", encoding="utf-8") as source:
        return {
            normalize_word(row["word"])
            for row in csv.DictReader(source)
            if row.get("word")
        }


def load_benchmark_lemmas() -> set[str]:
    lemmas: set[str] = set()
    for name in ("reader-dev-v2", "reader-filter-dev-v1"):
        path = ROOT / "data" / "processed" / f"{name}.jsonl"
        for line in path.read_text(encoding="utf-8").splitlines():
            if line:
                lemmas.add(normalize_word(str(json.loads(line)["lemma"])))
    return lemmas


def stable_order(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def select_examples(examples: tuple[Example, ...], limit: int) -> list[Example]:
    unique = {(example.text, example.target): example for example in examples}
    return sorted(
        unique.values(),
        key=lambda item: stable_order(f"{item.text}\n{item.target}"),
    )[:limit]


def training_rows(word: str, part_of_speech: str, senses: list[Sense]) -> list[dict]:
    all_definitions: list[str] = []
    for sense in senses:
        for definition in sense.definitions:
            if definition not in all_definitions:
                all_definitions.append(definition)
    if len(all_definitions) < 2 or len(all_definitions) > 30:
        return []

    rows: list[dict] = []
    for sense_index, sense in enumerate(senses):
        positive = sense.definitions[0]
        same_sense = set(sense.definitions)
        negatives = [
            definition
            for definition in all_definitions
            if definition not in same_sense
        ]
        negatives.sort(key=lambda item: stable_order(f"{word}\n{positive}\n{item}"))
        if not negatives:
            continue
        for example in select_examples(sense.examples, 2):
            rows.append({
                "id": stable_order(
                    f"{word}\n{part_of_speech}\n{sense_index}\n{example.text}"
                )[:24],
                "context": example.text,
                "target": example.target,
                "lemma": word,
                "pos": part_of_speech,
                "positive_gloss": positive,
                "negative_glosses": negatives[:5],
            })
    rows.sort(key=lambda row: stable_order(str(row["id"])))
    return rows[:12]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-rows", type=int, required=True)
    args = parser.parse_args()
    if args.max_rows < 1:
        raise ValueError(f"max-rows must be positive, got {args.max_rows}")
    vocabulary = load_vocabulary()
    excluded_lemmas = load_benchmark_lemmas()
    grouped: dict[tuple[str, str], list[Sense]] = {}
    scanned = 0
    compatible = 0
    with gzip.open(ARCHIVE, "rt", encoding="utf-8") as source:
        for line_number, line in enumerate(source, start=1):
            scanned += 1
            if scanned % 100_000 == 0:
                print(json.dumps({
                    "scanned": scanned,
                    "compatible_records": compatible,
                    "groups": len(grouped),
                }), flush=True)
            try:
                payload = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"Invalid Wiktextract JSON at line {line_number}") from error
            if payload.get("lang_code") != "en":
                continue
            word = normalize_word(str(payload.get("word", "")))
            raw_pos = str(payload.get("pos", ""))
            part_of_speech = OPEN_CLASS_POS.get(raw_pos)
            if (
                not part_of_speech
                or word not in vocabulary
                or word in excluded_lemmas
                or not WORD_RE.fullmatch(word)
            ):
                continue
            senses: list[Sense] = []
            for raw_sense in payload.get("senses", []):
                if not isinstance(raw_sense, dict):
                    continue
                definitions = primary_definitions(raw_sense)
                examples = sense_examples(raw_sense)
                if definitions and examples:
                    senses.append(Sense(definitions=definitions, examples=examples))
            if senses:
                grouped.setdefault((word, part_of_speech), []).extend(senses)
                compatible += 1

    rows = [
        row
        for (word, part_of_speech), senses in sorted(grouped.items())
        for row in training_rows(word, part_of_speech, senses)
    ]
    rows.sort(key=lambda row: stable_order(str(row["id"])))
    rows = rows[:args.max_rows]
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        "".join(json.dumps(row, ensure_ascii=True) + "\n" for row in rows),
        encoding="utf-8",
    )
    print(json.dumps({
        "scanned": scanned,
        "compatible_records": compatible,
        "groups": len(grouped),
        "training_rows": len(rows),
        "output": str(OUTPUT.relative_to(ROOT)),
    }, indent=2))


if __name__ == "__main__":
    main()
