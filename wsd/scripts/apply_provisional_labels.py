from __future__ import annotations

import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "reader-dev-v1-draft.jsonl"
OUTPUT = ROOT / "data" / "reader-dev-v1-review.csv"

# Conservative manual annotation of the initial 29-context batch. Every
# candidate not explicitly listed below is clearly incompatible with context.
LABELS: dict[str, dict[str, set[str]]] = {
    "reader-dev-draft-1": {"fits": {"watches.noun.1"}, "plausible": set()},
    "reader-dev-draft-2": {"fits": {"change.noun.1"}, "plausible": set()},
    "reader-dev-draft-3": {"fits": {"letters.noun.1"}, "plausible": set()},
    "reader-dev-draft-4": {"fits": {"interesting.adjective.1"}, "plausible": {"interesting.adjective.2"}},
    "reader-dev-draft-5": {"fits": {"name.noun.1"}, "plausible": {"name.noun.7"}},
    "reader-dev-draft-6": {"fits": {"kind.noun.1"}, "plausible": set()},
    "reader-dev-draft-7": {"fits": {"company.noun.10"}, "plausible": {"company.noun.12"}},
    "reader-dev-draft-8": {"fits": {"contents.noun.1"}, "plausible": {"contents.noun.2"}},
    "reader-dev-draft-9": {"fits": {"subject.noun.3"}, "plausible": {"subject.noun.4"}},
    "reader-dev-draft-10": {"fits": {"project.noun.1"}, "plausible": set()},
    "reader-dev-draft-11": {"fits": {"motioned.verb.1"}, "plausible": set()},
    "reader-dev-draft-12": {"fits": {"palm.noun.1"}, "plausible": set()},
    "reader-dev-draft-13": {"fits": {"rule.noun.8"}, "plausible": set()},
    "reader-dev-draft-14": {"fits": {"current.adjective.1"}, "plausible": {"current.adjective.2"}},
    "reader-dev-draft-15": {"fits": {"model.noun.3"}, "plausible": {"model.noun.11"}},
    "reader-dev-draft-16": {"fits": {"objects.noun.1"}, "plausible": set()},
    "reader-dev-draft-17": {"fits": {"project.noun.1"}, "plausible": set()},
    "reader-dev-draft-18": {"fits": {"contents.noun.1"}, "plausible": {"contents.noun.2"}},
    "reader-dev-draft-19": {"fits": {"name.noun.1"}, "plausible": set()},
    "reader-dev-draft-20": {"fits": {"row.noun.1"}, "plausible": set()},
    "reader-dev-draft-21": {"fits": {"kind.adjective.1"}, "plausible": {"kind.adjective.2"}},
    "reader-dev-draft-22": {"fits": {"changed.verb.1"}, "plausible": set()},
    "reader-dev-draft-23": {"fits": {"subject.noun.3"}, "plausible": {"subject.noun.4"}},
    "reader-dev-draft-24": {"fits": {"interesting.adjective.1"}, "plausible": {"interesting.adjective.2"}},
    "reader-dev-draft-25": {"fits": {"letter.noun.2"}, "plausible": set()},
    "reader-dev-draft-26": {"fits": {"watch.noun.1"}, "plausible": set()},
    "reader-dev-draft-27": {"fits": {"rule.noun.1"}, "plausible": set()},
    "reader-dev-draft-28": {"fits": {"company.noun.2"}, "plausible": {"company.noun.10"}},
    "reader-dev-draft-29": {"fits": {"current.adjective.1"}, "plausible": {"current.adjective.2"}},
}


def main() -> None:
    examples = [json.loads(line) for line in SOURCE.read_text(encoding="utf-8").splitlines() if line]
    rows: list[dict[str, str]] = []
    seen: dict[str, set[str]] = {example["id"]: set() for example in examples}
    for example in examples:
        labels = LABELS[example["id"]]
        for candidate in example["candidates"]:
            sense_id = candidate["sense_id"]
            relevance = "fits" if sense_id in labels["fits"] else "plausible" if sense_id in labels["plausible"] else "clearly_wrong"
            if relevance != "clearly_wrong":
                seen[example["id"]].add(sense_id)
            rows.append({
                "example_id": example["id"], "source_file": example["source"]["file"], "context": example["context"],
                "target": example["target"], "lemma": example["lemma"], "part_of_speech": candidate["part_of_speech"],
                "sense_id": sense_id, "gloss": candidate["gloss"], "relevance": relevance,
                "reviewer_notes": "Initial assistant annotation; revise if you disagree." if relevance != "clearly_wrong" else "",
            })
    missing = {
        example_id: LABELS[example_id][label] - senses
        for example_id, senses in seen.items()
        for label in ("fits", "plausible")
        if LABELS[example_id][label] - senses
    }
    if missing:
        raise SystemExit(f"Configured sense IDs missing from draft: {missing}")
    with OUTPUT.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(destination, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {len(rows)} provisionally labeled rows to {OUTPUT}")


if __name__ == "__main__":
    main()
