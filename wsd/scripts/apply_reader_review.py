from __future__ import annotations

import csv
import json
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ALLOWED = {"fits", "plausible", "clearly_wrong"}
CONFIDENCE = {"high", "medium", "low"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="reader-dev-v1")
    args = parser.parse_args()
    source_path = ROOT / "data" / f"{args.dataset}-draft.jsonl"
    review_path = ROOT / "data" / f"{args.dataset}-review.csv"
    output_path = ROOT / "data" / "processed" / f"{args.dataset}.jsonl"
    exclusions_path = ROOT / "data" / f"{args.dataset}-exclusions.json"
    exclusions = json.loads(exclusions_path.read_text(encoding="utf-8")) if exclusions_path.exists() else {}
    stability_path = ROOT / "data" / f"{args.dataset}-stability-review.json"
    stability = json.loads(stability_path.read_text(encoding="utf-8")) if stability_path.exists() else {}
    stability_reasons = {
        identifier: reason
        for reason, identifiers in stability.get("reviewed_without_label_changes", {}).items()
        for identifier in identifiers
    }
    labels: dict[str, str] = {}
    confidence: dict[str, str] = {}
    with review_path.open(newline="", encoding="utf-8") as source:
        for row in csv.DictReader(source):
            if row["example_id"] in exclusions:
                continue
            label = row["relevance"].strip()
            if label not in ALLOWED:
                raise SystemExit(f"{row['example_id']} / {row['sense_id']}: expected one of {sorted(ALLOWED)}, got {label!r}")
            labels[f"{row['example_id']}:{row['sense_id']}"] = label
            value = row.get("annotation_confidence", "").strip()
            if value:
                if value not in CONFIDENCE:
                    raise SystemExit(f"{row['example_id']}: invalid annotation confidence {value!r}")
                confidence[row["example_id"]] = value

    output_path.parent.mkdir(parents=True, exist_ok=True)
    written = skipped = 0
    with output_path.open("w", encoding="utf-8") as destination:
        for line in source_path.read_text(encoding="utf-8").splitlines():
            example = json.loads(line)
            if example["id"] in exclusions:
                skipped += 1
                continue
            if len(example["candidates"]) < 2:
                skipped += 1
                continue
            for candidate in example["candidates"]:
                key = f"{example['id']}:{candidate['sense_id']}"
                if key not in labels:
                    raise SystemExit(f"Missing CSV review row: {key}")
                candidate["relevance"] = labels[key]
            example["dataset"] = args.dataset
            example["annotation_confidence"] = confidence.get(example["id"], "medium")
            if example["id"] in stability_reasons:
                example["stability_review"] = {
                    "status": "reviewed_without_label_changes",
                    "selection_reason": stability_reasons[example["id"]],
                }
            example.pop("review_status", None)
            destination.write(json.dumps(example, ensure_ascii=True) + "\n")
            written += 1
    print(f"wrote {written} reviewed examples to {output_path}; excluded or skipped {skipped} examples")


if __name__ == "__main__":
    main()
