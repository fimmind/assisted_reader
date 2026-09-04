from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from metrics import ACCEPTABLE_LABELS, ranking
from rankers import load_ranker

ROOT = Path(__file__).resolve().parents[1]


def candidate_pos(candidate: dict) -> str | None:
    return candidate.get("part_of_speech", candidate.get("pos"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="reader-dev-v1")
    parser.add_argument("--model", required=True)
    parser.add_argument("--worst-margins", type=int, default=50)
    args = parser.parse_args()
    source = ROOT / "data" / "processed" / f"{args.dataset}.jsonl"
    examples = [json.loads(line) for line in source.read_text(encoding="utf-8").splitlines() if line]
    ranker = load_ranker(args.model)
    final_scores, raw_scores = ranker.score_with_raw_many(examples)
    error_rows: list[dict] = []
    margin_examples: list[tuple[float, dict, list[float], list[float]]] = []
    for example, scores, raw in zip(examples, final_scores, raw_scores):
        order = ranking(scores)
        top = example["candidates"][order[0]]
        if top.get("relevance") == "clearly_wrong":
            for rank, index in enumerate(order, start=1):
                candidate = example["candidates"][index]
                error_rows.append({
                    "id": example["id"], "context": example["context"], "target": example["target"],
                    "contextual_pos": example.get("pos"), "candidate_rank": rank,
                    "candidate_pos": candidate_pos(candidate), "relevance": candidate.get("relevance"),
                    "raw_semantic_score": raw[index], "final_pos_adjusted_score": scores[index],
                    "original_dictionary_rank": candidate.get("original_rank", index),
                    "sense_id": candidate.get("sense_id"), "definition": candidate["gloss"],
                })
        target_pos = example.get("pos")
        good = [raw[i] for i, candidate in enumerate(example["candidates"]) if candidate_pos(candidate) == target_pos and candidate.get("relevance") in ACCEPTABLE_LABELS]
        bad = [raw[i] for i, candidate in enumerate(example["candidates"]) if candidate_pos(candidate) == target_pos and candidate.get("relevance") == "clearly_wrong"]
        if good and bad:
            margin_examples.append((max(good) - max(bad), example, scores, raw))

    output_dir = ROOT / "results"
    output_dir.mkdir(exist_ok=True)
    error_output = output_dir / f"{args.dataset}-{args.model}-top-errors.csv"
    with error_output.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(destination, fieldnames=list(error_rows[0]) if error_rows else ["id"])
        writer.writeheader(); writer.writerows(error_rows)

    margin_rows: list[dict] = []
    for margin, example, scores, raw in sorted(margin_examples, key=lambda item: item[0])[:args.worst_margins]:
        for rank, index in enumerate(ranking(scores), start=1):
            candidate = example["candidates"][index]
            if candidate_pos(candidate) != example.get("pos"):
                continue
            margin_rows.append({
                "id": example["id"], "acceptable_wrong_margin": margin, "context": example["context"],
                "target": example["target"], "contextual_pos": example.get("pos"), "candidate_rank": rank,
                "candidate_pos": candidate_pos(candidate), "relevance": candidate.get("relevance"),
                "raw_semantic_score": raw[index], "final_pos_adjusted_score": scores[index],
                "original_dictionary_rank": candidate.get("original_rank", index), "sense_id": candidate.get("sense_id"),
                "definition": candidate["gloss"],
            })
    margin_output = output_dir / f"{args.dataset}-{args.model}-worst-same-pos-margins.csv"
    with margin_output.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(destination, fieldnames=list(margin_rows[0]) if margin_rows else ["id"])
        writer.writeheader(); writer.writerows(margin_rows)
    print(f"wrote {len(error_rows)} catastrophic-error candidate rows to {error_output}")
    print(f"wrote {len(margin_rows)} same-POS margin candidate rows to {margin_output}")


if __name__ == "__main__":
    main()
