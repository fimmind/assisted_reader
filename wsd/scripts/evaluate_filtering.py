from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from filtering import (
    ScoredExample,
    calibrate_margin_threshold,
    conformal_margin_threshold,
    filtering_metrics,
    fixed_top_k,
    runtime_example,
    within_best_margin,
    within_best_margin_unbounded,
)
from rankers import load_ranker

ROOT = Path(__file__).resolve().parents[1]


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as source:
        return list(csv.DictReader(source))


def local_cache_size_mb(name: str) -> float:
    name = {
        "arctic-embed-xs-rrf": "arctic-embed-xs",
        "arctic-embed-xs-rrf-25": "arctic-embed-xs",
        "arctic-embed-xs-rrf-75": "arctic-embed-xs",
        "e5-definition-only-rrf": "e5-small",
        "e5-definition-only-rrf-25": "e5-small",
        "e5-definition-only-rrf-75": "e5-small",
        "e5-small-definition-only": "e5-small",
        "pos-e5-small-rrf": "e5-small",
        "pos-wsl-retriever-rrf": "wsl-retriever",
    }.get(name, name)
    directory = ROOT / ".cache" / "models" / name
    if not directory.exists():
        return 0.0
    return sum(
        path.stat().st_size
        for path in directory.rglob("*")
        if path.is_file() and ".cache" not in path.relative_to(directory).parts
    ) / 1_000_000


def evaluate_policy(
    model_name: str,
    policy: str,
    slice_name: str,
    scored: list[ScoredExample],
    selections: list[list[int]],
    preparation_ms: float,
    online_ms: float,
    threshold: float | str,
) -> dict[str, float | int | str]:
    return {
        "model": model_name,
        "policy": policy,
        "slice": slice_name,
        "threshold": threshold,
        "local_cache_mb": local_cache_size_mb(model_name),
        "offline_preparation_ms": preparation_ms,
        "online_ms": online_ms,
        "online_examples_per_second": len(scored) / (online_ms / 1000) if online_ms else 0.0,
        **filtering_metrics(scored, selections),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--model", nargs="+", required=True)
    parser.add_argument("--max-definitions", type=int, required=True)
    parser.add_argument("--append", action="store_true")
    args = parser.parse_args()
    if args.max_definitions != 3:
        raise ValueError(
            f"This benchmark's reporting schema currently requires --max-definitions 3, got {args.max_definitions}"
        )

    source = ROOT / "data" / "processed" / f"{args.dataset}.jsonl"
    original_examples = read_jsonl(source)
    examples = [runtime_example(example) for example in original_examples]
    output_rows: list[dict[str, float | int | str]] = []
    for model_name in args.model:
        ranker = load_ranker(model_name)
        benchmark = ranker.benchmark_score_many(examples)
        scored = [
            ScoredExample(example=example, scores=scores)
            for example, scores in zip(examples, benchmark.scores)
        ]
        slices = {"all": scored}
        if any(item.example.get("benchmark_split") for item in scored):
            slices.update({
                "calibration": [
                    item for item in scored if item.example.get("benchmark_split") == "calibration"
                ],
                "evaluation": [
                    item for item in scored if item.example.get("benchmark_split") == "evaluation"
                ],
            })
        else:
            slices["crowded"] = [item for item in scored if len(item.example["candidates"]) > 5]

        for slice_name, slice_scored in slices.items():
            if not slice_scored:
                continue
            ratio = len(slice_scored) / len(scored)
            for maximum in range(1, args.max_definitions + 1):
                selections = [fixed_top_k(item.scores, maximum) for item in slice_scored]
                output_rows.append(evaluate_policy(
                    model_name=model_name,
                    policy=f"fixed-top-{maximum}",
                    slice_name=slice_name,
                    scored=slice_scored,
                    selections=selections,
                    preparation_ms=benchmark.preparation_ms * ratio,
                    online_ms=benchmark.online_ms * ratio,
                    threshold="",
                ))

        calibration = slices.get("calibration")
        evaluation = slices.get("evaluation")
        if calibration and evaluation:
            threshold = calibrate_margin_threshold(calibration, args.max_definitions)
            for slice_name, slice_scored in (("calibration", calibration), ("evaluation", evaluation)):
                ratio = len(slice_scored) / len(scored)
                selections = [
                    within_best_margin(item.scores, args.max_definitions, threshold)
                    for item in slice_scored
                ]
                output_rows.append(evaluate_policy(
                    model_name=model_name,
                    policy="adaptive-margin",
                    slice_name=slice_name,
                    scored=slice_scored,
                    selections=selections,
                    preparation_ms=benchmark.preparation_ms * ratio,
                    online_ms=benchmark.online_ms * ratio,
                    threshold=threshold,
                ))
            for miscoverage_rate in (0.05, 0.1):
                conformal_threshold = conformal_margin_threshold(
                    calibration,
                    miscoverage_rate,
                )
                for slice_name, slice_scored in (
                    ("calibration", calibration),
                    ("evaluation", evaluation),
                ):
                    ratio = len(slice_scored) / len(scored)
                    selections = [
                        within_best_margin_unbounded(item.scores, conformal_threshold)
                        for item in slice_scored
                    ]
                    output_rows.append(evaluate_policy(
                        model_name=model_name,
                        policy=f"conformal-{miscoverage_rate:.2f}",
                        slice_name=slice_name,
                        scored=slice_scored,
                        selections=selections,
                        preparation_ms=benchmark.preparation_ms * ratio,
                        online_ms=benchmark.online_ms * ratio,
                        threshold=conformal_threshold,
                    ))

    output_dir = ROOT / "results"
    output_dir.mkdir(exist_ok=True)
    output = output_dir / f"{args.dataset}-filtering.csv"
    if args.append and output.exists():
        existing_rows = read_csv(output)
        replaced_models = set(args.model)
        output_rows = [
            row for row in existing_rows if row.get("model") not in replaced_models
        ] + output_rows
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
