from __future__ import annotations

import csv
import json
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="reader-dev-v1")
    args = parser.parse_args()
    source_path = ROOT / "data" / f"{args.dataset}-draft.jsonl"
    output_path = ROOT / "data" / f"{args.dataset}-review.csv"
    rows = []
    for line in source_path.read_text(encoding="utf-8").splitlines():
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
                "annotation_confidence": example.get("annotation_confidence", "unreviewed"),
                "reviewer_notes": "",
            })
    with output_path.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(destination, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {len(rows)} review rows to {output_path}")


if __name__ == "__main__":
    main()
