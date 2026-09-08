from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from filtering import ScoredExample, fixed_top_k, runtime_example
from metrics import ACCEPTABLE_LABELS, ranking
from rankers import load_ranker


ROOT = Path(__file__).resolve().parents[1]


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def failure_rows(scored: list[ScoredExample], maximum: int) -> list[dict[str, str | int | float]]:
    rows: list[dict[str, str | int | float]] = []
    for item in scored:
        retained = set(fixed_top_k(item.scores, maximum))
        labels = [candidate["relevance"] for candidate in item.example["candidates"]]
        if any(labels[index] in ACCEPTABLE_LABELS for index in retained):
            continue
        rank_by_index = {
            index: position
            for position, index in enumerate(ranking(item.scores), start=1)
        }
        for index, (candidate, score) in enumerate(zip(item.example["candidates"], item.scores)):
            rows.append({
                "id": item.example["id"],
                "context": item.example["context"],
                "target": item.example["target"],
                "lemma": item.example["lemma"],
                "pos": item.example["pos"],
                "candidate_rank": rank_by_index[index],
                "dictionary_rank": index + 1,
                "score": score,
                "relevance": candidate["relevance"],
                "gloss": candidate["gloss"],
            })
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--maximum", type=int, required=True)
    args = parser.parse_args()
    if args.maximum < 1:
        raise ValueError(f"maximum must be positive, got {args.maximum}")

    source = ROOT / "data" / "processed" / f"{args.dataset}.jsonl"
    examples = [
        runtime_example(example)
        for example in read_jsonl(source)
        if example.get("benchmark_split") == "evaluation"
    ]
    scores = load_ranker(args.model).score_many(examples)
    rows = failure_rows([
        ScoredExample(example=example, scores=item_scores)
        for example, item_scores in zip(examples, scores)
    ], args.maximum)
    output = ROOT / "results" / f"{args.dataset}-{args.model}-top-{args.maximum}-failures.csv"
    output.parent.mkdir(exist_ok=True)
    with output.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(destination, fieldnames=list(rows[0]) if rows else ["id"])
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps({
        "failure_examples": len({row["id"] for row in rows}),
        "candidate_rows": len(rows),
        "output": str(output.relative_to(ROOT)),
    }))


if __name__ == "__main__":
    main()
