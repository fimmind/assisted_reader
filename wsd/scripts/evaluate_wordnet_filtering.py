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
    within_best_margin_unbounded,
)
from rankers import load_ranker


ROOT = Path(__file__).resolve().parents[1]


def read_jsonl(path: Path) -> list[dict]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def load_datasets(names: list[str]) -> list[dict]:
    examples: list[dict] = []
    for name in names:
        path = ROOT / "data" / "processed" / f"{name}.jsonl"
        examples.extend(read_jsonl(path))
    return examples


def with_gold_relevance(example: dict) -> dict:
    gold = set(example["gold"])
    candidates = [
        {
            **candidate,
            "relevance": "fits" if candidate["sense_id"] in gold else "clearly_wrong",
        }
        for candidate in example["candidates"]
    ]
    if not any(candidate["relevance"] == "fits" for candidate in candidates):
        raise ValueError(f"Gold sense is absent from candidates: {example.get('id')}")
    return {**example, "candidates": candidates}


def result_row(
    model: str,
    policy: str,
    split: str,
    scored: list[ScoredExample],
    selections: list[list[int]],
    preparation_ms: float,
    online_ms: float,
    threshold: float | str,
) -> dict[str, float | int | str]:
    return {
        "model": model,
        "policy": policy,
        "split": split,
        "threshold": threshold,
        "offline_preparation_ms": preparation_ms,
        "online_ms": online_ms,
        "online_examples_per_second": len(scored) / (online_ms / 1000) if online_ms else 0.0,
        **filtering_metrics(scored, selections),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--calibration-dataset", default="raganato-semeval2007")
    parser.add_argument(
        "--evaluation-dataset",
        nargs="+",
        default=[
            "raganato-senseval2",
            "raganato-senseval3",
            "raganato-semeval2013",
            "raganato-semeval2015",
        ],
    )
    parser.add_argument("--model", nargs="+", required=True)
    parser.add_argument("--max-definitions", type=int, default=3)
    args = parser.parse_args()
    if args.max_definitions < 1:
        raise ValueError(f"max-definitions must be positive, got {args.max_definitions}")

    calibration_examples = [
        with_gold_relevance(example)
        for example in load_datasets([args.calibration_dataset])
    ]
    evaluation_examples = [
        with_gold_relevance(example)
        for example in load_datasets(args.evaluation_dataset)
    ]
    examples = calibration_examples + evaluation_examples
    calibration_count = len(calibration_examples)
    output_rows: list[dict[str, float | int | str]] = []

    for model_name in args.model:
        ranker = load_ranker(model_name)
        benchmark = ranker.benchmark_score_many(examples)
        scored = [
            ScoredExample(example=example, scores=scores)
            for example, scores in zip(examples, benchmark.scores)
        ]
        calibration = scored[:calibration_count]
        evaluation = scored[calibration_count:]
        for split_name, split_scored in (
            ("calibration", calibration),
            ("evaluation", evaluation),
        ):
            ratio = len(split_scored) / len(scored)
            for maximum in range(1, args.max_definitions + 1):
                selections = [fixed_top_k(item.scores, maximum) for item in split_scored]
                output_rows.append(result_row(
                    model=model_name,
                    policy=f"fixed-top-{maximum}",
                    split=split_name,
                    scored=split_scored,
                    selections=selections,
                    preparation_ms=benchmark.preparation_ms * ratio,
                    online_ms=benchmark.online_ms * ratio,
                    threshold="",
                ))

        for miscoverage_rate in (0.01, 0.05, 0.1):
            threshold = conformal_margin_threshold(calibration, miscoverage_rate)
            for split_name, split_scored in (
                ("calibration", calibration),
                ("evaluation", evaluation),
            ):
                ratio = len(split_scored) / len(scored)
                selections = [
                    within_best_margin_unbounded(item.scores, threshold)
                    for item in split_scored
                ]
                output_rows.append(result_row(
                    model=model_name,
                    policy=f"conformal-{miscoverage_rate:.2f}",
                    split=split_name,
                    scored=split_scored,
                    selections=selections,
                    preparation_ms=benchmark.preparation_ms * ratio,
                    online_ms=benchmark.online_ms * ratio,
                    threshold=threshold,
                ))

    output_dir = ROOT / "results"
    output_dir.mkdir(exist_ok=True)
    output = output_dir / "wordnet-filtering.csv"
    with output.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(
            destination,
            fieldnames=sorted({key for row in output_rows for key in row}),
        )
        writer.writeheader()
        writer.writerows(output_rows)
    print(f"wrote {output}")


if __name__ == "__main__":
    main()
