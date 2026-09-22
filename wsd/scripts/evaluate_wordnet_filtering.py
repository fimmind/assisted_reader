from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from benchmarking import (
    checkpoint_path,
    files_digest,
    load_score_checkpoint,
    native_thread_settings,
    ranker_implementation_sha256,
    ranker_revision,
    runtime_versions,
    save_score_checkpoint,
    write_csv_rows,
)
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
    provenance: dict[str, float | int | str],
) -> dict[str, float | int | str]:
    return {
        "model": model,
        "policy": policy,
        "split": split,
        "threshold": threshold,
        "offline_preparation_ms": preparation_ms,
        "online_ms": online_ms,
        "online_examples_per_second": len(scored) / (online_ms / 1000) if online_ms else 0.0,
        **provenance,
        **filtering_metrics(scored, selections),
    }


def evaluation_slices(
    scored: list[ScoredExample],
) -> list[tuple[str, list[ScoredExample]]]:
    slices: list[tuple[str, list[ScoredExample]]] = [("evaluation", scored)]
    datasets = sorted({str(item.example["dataset"]) for item in scored})
    parts_of_speech = sorted({str(item.example["pos"]) for item in scored})
    for dataset in datasets:
        slices.append((
            f"evaluation/dataset/{dataset}",
            [item for item in scored if item.example["dataset"] == dataset],
        ))
    for part_of_speech in parts_of_speech:
        slices.append((
            f"evaluation/pos/{part_of_speech}",
            [item for item in scored if item.example["pos"] == part_of_speech],
        ))
    for label, minimum, maximum in (
        ("2-3", 2, 3),
        ("4-7", 4, 7),
        ("8-plus", 8, float("inf")),
    ):
        slices.append((
            f"evaluation/candidates/{label}",
            [
                item
                for item in scored
                if minimum <= len(item.example["candidates"]) <= maximum
            ],
        ))
    return [(name, items) for name, items in slices if items]


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

    calibration_paths = [
        ROOT / "data" / "processed" / f"{args.calibration_dataset}.jsonl"
    ]
    evaluation_paths = [
        ROOT / "data" / "processed" / f"{name}.jsonl"
        for name in args.evaluation_dataset
    ]
    dataset_sha256 = files_digest(calibration_paths + evaluation_paths)
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
    output_dir = ROOT / "results"
    output_dir.mkdir(exist_ok=True)
    output = output_dir / "wordnet-filtering.csv"
    output_rows: list[dict[str, float | int | str]] = []
    if output.is_file():
        with output.open(newline="", encoding="utf-8") as existing_file:
            output_rows = [
                row
                for row in csv.DictReader(existing_file)
                if row.get("status") == "complete"
                and row.get("dataset_sha256") == dataset_sha256
            ]

    for model_name in args.model:
        ranker = load_ranker(model_name)
        revision = ranker_revision(ranker)
        checkpoint = checkpoint_path(
            output_dir,
            f"wordnet-filtering-{dataset_sha256[:12]}",
            model_name,
        )
        benchmark = load_score_checkpoint(checkpoint, dataset_sha256, revision)
        score_source = "checkpoint"
        if benchmark is None:
            benchmark = ranker.benchmark_score_many(examples)
            save_score_checkpoint(checkpoint, dataset_sha256, revision, benchmark)
            score_source = "computed"
        provenance: dict[str, float | int | str] = {
            "status": "complete",
            "dataset_sha256": dataset_sha256,
            "model_revision": revision,
            "runtime_versions": runtime_versions(),
            "ranker_implementation_sha256": ranker_implementation_sha256(),
            "native_thread_settings": native_thread_settings(),
            "score_source": score_source,
            "definition_inputs": benchmark.definition_inputs,
            "unique_definition_inputs": benchmark.unique_definition_inputs,
            "definition_cache_hit": str(benchmark.definition_cache_hit).lower(),
        }
        output_rows = [row for row in output_rows if row.get("model") != model_name]
        model_rows: list[dict[str, float | int | str]] = []
        scored = [
            ScoredExample(example=example, scores=scores)
            for example, scores in zip(examples, benchmark.scores)
        ]
        calibration = scored[:calibration_count]
        evaluation = scored[calibration_count:]
        reporting_slices = [("calibration", calibration), *evaluation_slices(evaluation)]
        for split_name, split_scored in reporting_slices:
            ratio = len(split_scored) / len(scored)
            for maximum in range(1, args.max_definitions + 1):
                selections = [fixed_top_k(item.scores, maximum) for item in split_scored]
                model_rows.append(result_row(
                    model=model_name,
                    policy=f"fixed-top-{maximum}",
                    split=split_name,
                    scored=split_scored,
                    selections=selections,
                    preparation_ms=benchmark.preparation_ms * ratio,
                    online_ms=benchmark.online_ms * ratio,
                    threshold="",
                    provenance=provenance,
                ))

        for miscoverage_rate in (0.01, 0.05, 0.1):
            threshold = conformal_margin_threshold(calibration, miscoverage_rate)
            for split_name, split_scored in reporting_slices:
                ratio = len(split_scored) / len(scored)
                selections = [
                    within_best_margin_unbounded(item.scores, threshold)
                    for item in split_scored
                ]
                model_rows.append(result_row(
                    model=model_name,
                    policy=f"conformal-{miscoverage_rate:.2f}",
                    split=split_name,
                    scored=split_scored,
                    selections=selections,
                    preparation_ms=benchmark.preparation_ms * ratio,
                    online_ms=benchmark.online_ms * ratio,
                    threshold=threshold,
                    provenance=provenance,
                ))
        output_rows.extend(model_rows)
        write_csv_rows(output, output_rows)
        print(f"wrote {output} after model={model_name}")


if __name__ == "__main__":
    main()
