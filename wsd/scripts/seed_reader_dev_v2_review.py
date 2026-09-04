from __future__ import annotations

import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DRAFT = ROOT / "data" / "reader-dev-v2-draft.jsonl"
V1 = ROOT / "data" / "processed" / "reader-dev-v1.jsonl"
OUTPUT = ROOT / "data" / "reader-dev-v2-review.csv"


def main() -> None:
    old_examples = [json.loads(line) for line in V1.read_text(encoding="utf-8").splitlines() if line]
    old_by_occurrence = {(example["context"], example["target"].lower()): example for example in old_examples}
    examples = [json.loads(line) for line in DRAFT.read_text(encoding="utf-8").splitlines() if line]
    rows: list[dict[str, str | int]] = []
    transferred = automatic = unresolved = 0
    for example in examples:
        old = old_by_occurrence.get((example["context"], example["target"].lower()))
        old_labels = {candidate["sense_id"]: candidate["relevance"] for candidate in old["candidates"]} if old else {}
        matching = [candidate for candidate in example["candidates"] if candidate["part_of_speech"] == example["pos"]]
        confidence = "high" if old or len(matching) == 1 else "unreviewed"
        if old:
            transferred += 1
        elif len(matching) == 1:
            automatic += 1
        else:
            unresolved += 1
        for candidate in example["candidates"]:
            if candidate["sense_id"] in old_labels:
                relevance = old_labels[candidate["sense_id"]]
                note = "Transferred from reviewed reader-dev-v1 occurrence."
            elif candidate["part_of_speech"] != example["pos"]:
                relevance = "clearly_wrong"
                note = "Deterministic contextual-POS mismatch seed."
            elif len(matching) == 1:
                relevance = "fits"
                note = "Only runtime candidate matching contextual POS; verify in stability review."
            else:
                relevance = "needs_review"
                note = ""
            rows.append({
                "example_id": example["id"], "source_file": example["source"]["file"], "context": example["context"],
                "target": example["target"], "lemma": example["lemma"], "contextual_pos": example["pos"],
                "number_of_candidates": example["number_of_candidates"],
                "number_of_matching_pos_candidates": example["number_of_matching_pos_candidates"],
                "part_of_speech": candidate["part_of_speech"], "sense_id": candidate["sense_id"],
                "original_rank": candidate["original_rank"], "gloss": candidate["gloss"], "relevance": relevance,
                "annotation_confidence": confidence, "reviewer_notes": note,
            })
    with OUTPUT.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(destination, fieldnames=list(rows[0]))
        writer.writeheader(); writer.writerows(rows)
    print(json.dumps({"rows": len(rows), "transferred_examples": transferred, "single_matching_pos_examples": automatic, "unresolved_examples": unresolved}))


if __name__ == "__main__":
    main()
