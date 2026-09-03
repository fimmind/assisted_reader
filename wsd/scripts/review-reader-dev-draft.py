from __future__ import annotations

import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "reader-dev-v1-draft.jsonl"
OUTPUT = ROOT / "data" / "reader-dev-v1-review.csv"


def main() -> None:
    rows = []
    for line in SOURCE.read_text(encoding="utf-8").splitlines():
        example = json.loads(line)
        for candidate in example["candidates"]:
            rows.append({
                "example_id": example["id"],
                "source_file": example["source"]["file"],
                "context": example["context"],
                "target": example["target"],
                "lemma": example["lemma"],
                "part_of_speech": candidate["part_of_speech"],
                "sense_id": candidate["sense_id"],
                "gloss": candidate["gloss"],
                "relevance": candidate["relevance"],
                "reviewer_notes": "",
            })
    with OUTPUT.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(destination, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {len(rows)} review rows to {OUTPUT}")


if __name__ == "__main__":
    main()
