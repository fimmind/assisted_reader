from __future__ import annotations

import json
import argparse
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ALLOWED = {"fits", "plausible", "clearly_wrong"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="reader-dev-v1")
    args = parser.parse_args()
    path = ROOT / "data" / "processed" / f"{args.dataset}.jsonl"
    errors: list[str] = []
    records: list[dict] = []
    ids: set[str] = set()
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        record = json.loads(line)
        records.append(record)
        required = {"id", "dataset", "context", "target", "lemma", "pos", "candidates"}
        missing = required - record.keys()
        if missing:
            errors.append(f"line {line_number}: missing {sorted(missing)}")
            continue
        if record["dataset"] != args.dataset or len(record["candidates"]) < 2:
            errors.append(f"line {line_number}: invalid dataset or fewer than two candidates")
        if record["id"] in ids:
            errors.append(f"line {line_number}: duplicate id {record['id']}")
        ids.add(record["id"])
        actual_matching = sum(candidate.get("part_of_speech") == record.get("pos") for candidate in record["candidates"])
        if record.get("number_of_candidates", len(record["candidates"])) != len(record["candidates"]):
            errors.append(f"line {line_number}: incorrect number_of_candidates")
        if record.get("number_of_matching_pos_candidates", actual_matching) != actual_matching:
            errors.append(f"line {line_number}: incorrect number_of_matching_pos_candidates")
        labels = [candidate.get("relevance") for candidate in record["candidates"]]
        if not set(labels) <= ALLOWED or not any(label in {"fits", "plausible"} for label in labels):
            errors.append(f"line {line_number}: invalid relevance labels")
    if errors:
        raise SystemExit("\n".join(errors))
    confidence = Counter(record.get("annotation_confidence", "unspecified") for record in records)
    same_pos = sum(sum(candidate.get("part_of_speech") == record.get("pos") for candidate in record["candidates"]) >= 2 for record in records)
    candidates = sum(len(record["candidates"]) for record in records)
    print(json.dumps({"dataset": args.dataset, "examples": len(records), "candidates": candidates, "same_pos_examples": same_pos, "confidence": confidence}, default=dict))


if __name__ == "__main__":
    main()
