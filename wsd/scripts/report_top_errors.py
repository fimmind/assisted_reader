from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from metrics import ranking
from rankers import load_ranker

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="reader-dev-v1")
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    source = ROOT / "data" / "processed" / f"{args.dataset}.jsonl"
    examples = [json.loads(line) for line in source.read_text(encoding="utf-8").splitlines() if line]
    ranker = load_ranker(args.model)
    rows = []
    for example, scores in zip(examples, ranker.score_many(examples)):
        top_index = ranking(scores)[0]
        top = example["candidates"][top_index]
        if top["relevance"] != "clearly_wrong":
            continue
        rows.append({
            "id": example["id"], "target": example["target"], "lemma": example["lemma"], "pos": example.get("pos"),
            "context": example["context"], "top_sense_id": top["sense_id"], "top_gloss": top["gloss"],
            "top_pos": top.get("part_of_speech"), "top_score": scores[top_index],
        })
    output = ROOT / "results" / f"{args.dataset}-{args.model}-top-errors.csv"
    output.parent.mkdir(exist_ok=True)
    with output.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(destination, fieldnames=list(rows[0]) if rows else ["id"])
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {len(rows)} top-1 catastrophic errors to {output}")


if __name__ == "__main__":
    main()
