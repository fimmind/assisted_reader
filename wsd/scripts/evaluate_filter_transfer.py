from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from filtering import (
    ScoredExample,
    conformal_margin_threshold,
    filtering_metrics,
    fixed_top_k,
    runtime_example,
    within_best_margin_unbounded,
)
from rankers import load_ranker


ROOT = Path(__file__).resolve().parents[1]


def read_runtime_examples(dataset: str) -> list[dict]:
    path = ROOT / "data" / "processed" / f"{dataset}.jsonl"
    return [
        runtime_example(json.loads(line))
        for line in path.read_text(encoding="utf-8").splitlines()
        if line
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--calibration-dataset", required=True)
    parser.add_argument("--evaluation-dataset", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--miscoverage-rate", type=float, required=True)
    args = parser.parse_args()

    ranker = load_ranker(args.model)
    source = read_runtime_examples(args.calibration_dataset)
    source_scores = ranker.score_many(source)
    calibration = [
        ScoredExample(example=example, scores=scores)
        for example, scores in zip(source, source_scores)
        if example.get("benchmark_split") == "calibration"
    ]
    threshold = conformal_margin_threshold(calibration, args.miscoverage_rate)

    target = [
        example
        for example in read_runtime_examples(args.evaluation_dataset)
        if len(example["candidates"]) > 5
    ]
    target_scored = [
        ScoredExample(example=example, scores=scores)
        for example, scores in zip(target, ranker.score_many(target))
    ]
    policies = {
        "fixed-top-3": [fixed_top_k(item.scores, 3) for item in target_scored],
        "fixed-top-4": [fixed_top_k(item.scores, 4) for item in target_scored],
        f"conformal-{args.miscoverage_rate:.2f}": [
            within_best_margin_unbounded(item.scores, threshold)
            for item in target_scored
        ],
    }
    rows = [
        {
            "calibration_dataset": args.calibration_dataset,
            "evaluation_dataset": args.evaluation_dataset,
            "model": args.model,
            "policy": policy,
            "threshold": threshold if policy.startswith("conformal") else "",
            **filtering_metrics(target_scored, selections),
        }
        for policy, selections in policies.items()
    ]
    output = (
        ROOT
        / "results"
        / f"{args.evaluation_dataset}-{args.model}-transfer-filtering.csv"
    )
    with output.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(
            destination,
            fieldnames=sorted({key for row in rows for key in row}),
        )
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps({
        "rows": rows,
        "output": str(output.relative_to(ROOT)),
    }, indent=2))


if __name__ == "__main__":
    main()
