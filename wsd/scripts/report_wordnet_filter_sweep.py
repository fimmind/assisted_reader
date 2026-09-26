"""Recalculate 0%-5% calibrated filtering policies from saved full-set scores."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from benchmarking import checkpoint_path, files_digest
from evaluate_wordnet_filtering import ROOT, load_datasets, with_gold_relevance
from filtering import (
    ScoredExample,
    conformal_margin_threshold,
    filtering_metrics,
    within_best_margin_unbounded,
)


CALIBRATION = "raganato-semeval2007"
HELD_OUT = (
    "raganato-senseval2",
    "raganato-senseval3",
    "raganato-semeval2013",
    "raganato-semeval2015",
)


def checkpoint_scores(path: Path, dataset_sha256: str, expected_count: int) -> list[list[float]]:
    if not path.is_file():
        raise FileNotFoundError(f"Score checkpoint is missing: path={path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("status") != "complete" or payload.get("dataset_sha256") != dataset_sha256:
        raise ValueError(f"Score checkpoint does not match this dataset: path={path}")
    scores = payload["scores"]
    if len(scores) != expected_count:
        raise ValueError(
            f"Score checkpoint has wrong example count: path={path} expected={expected_count} actual={len(scores)}"
        )
    return scores


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", nargs="+", required=True)
    args = parser.parse_args()

    names = [CALIBRATION, *HELD_OUT]
    paths = [ROOT / "data" / "processed" / f"{name}.jsonl" for name in names]
    dataset_sha256 = files_digest(paths)
    examples = [with_gold_relevance(example) for example in load_datasets(names)]
    calibration_count = len(load_datasets([CALIBRATION]))
    rows: list[dict[str, float | int | str]] = []
    for model in args.model:
        checkpoint = checkpoint_path(
            ROOT / "results",
            f"wordnet-filtering-{dataset_sha256[:12]}",
            model,
        )
        scores = checkpoint_scores(checkpoint, dataset_sha256, len(examples))
        scored = [ScoredExample(example=example, scores=value) for example, value in zip(examples, scores)]
        calibration = scored[:calibration_count]
        evaluation = scored[calibration_count:]
        for percent in range(6):
            threshold = float("inf") if percent == 0 else conformal_margin_threshold(calibration, percent / 100)
            retained = [within_best_margin_unbounded(item.scores, threshold) for item in evaluation]
            metrics = filtering_metrics(evaluation, retained)
            rows.append({
                "model": model,
                "calibration_target_percent": percent,
                "threshold": threshold,
                "gold_excluded": int(metrics["unsafe_exclusions"]),
                "gold_excluded_rate": float(metrics["unsafe_exclusion_rate"]),
                "non_gold_suppressed": float(metrics["wrong_definition_suppression"]),
                "retained_precision": float(metrics["retained_definition_precision"]),
                "mean_definitions_shown": float(metrics["mean_definitions_shown"]),
                "evaluation_examples": int(metrics["examples"]),
                "dataset_sha256": dataset_sha256,
            })

    output = ROOT / "results" / "wordnet-filtering-0-to-5.csv"
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(destination, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {output}")


if __name__ == "__main__":
    main()
