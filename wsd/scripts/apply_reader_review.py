from __future__ import annotations

import csv
import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "reader-dev-v1-draft.jsonl"
REVIEW = ROOT / "data" / "reader-dev-v1-review.csv"
OUTPUT = ROOT / "data" / "processed" / "reader-dev-v1.jsonl"
ALLOWED = {"fits", "plausible", "clearly_wrong"}


def main() -> None:
    labels: dict[str, str] = {}
    with REVIEW.open(newline="", encoding="utf-8") as source:
        for row in csv.DictReader(source):
            label = row["relevance"].strip()
            if label not in ALLOWED:
                raise SystemExit(f"{row['example_id']} / {row['sense_id']}: expected one of {sorted(ALLOWED)}, got {label!r}")
            labels[f"{row['example_id']}:{row['sense_id']}"] = label

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    written = skipped = 0
    with OUTPUT.open("w", encoding="utf-8") as destination:
        for line in SOURCE.read_text(encoding="utf-8").splitlines():
            example = json.loads(line)
            if len(example["candidates"]) < 2:
                skipped += 1
                continue
            for candidate in example["candidates"]:
                key = f"{example['id']}:{candidate['sense_id']}"
                if key not in labels:
                    raise SystemExit(f"Missing CSV review row: {key}")
                candidate["relevance"] = labels[key]
            example["dataset"] = "reader-dev-v1"
            example.pop("review_status", None)
            destination.write(json.dumps(example, ensure_ascii=True) + "\n")
            written += 1
    print(f"wrote {written} reviewed examples to {OUTPUT}; skipped {skipped} single-candidate examples")


if __name__ == "__main__":
    main()
