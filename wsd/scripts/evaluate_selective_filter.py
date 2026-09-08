from __future__ import annotations

import argparse
import csv
import json
from dataclasses import dataclass
from pathlib import Path

from filtering import ScoredExample, filtering_metrics, fixed_top_k, runtime_example
from metrics import ACCEPTABLE_LABELS, ranking
from rankers import load_ranker, reciprocal_rank_fusion_scores


ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class RankedExample:
    scored: ScoredExample
    semantic_scores: list[float]
    semantic_order: list[int]
    fused_order: list[int]


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def score_gap(scores: list[float], order: list[int], left: int, right: int) -> float:
    if len(order) <= right:
        return float("inf")
    return scores[order[left]] - scores[order[right]]


def confidence_values(example: RankedExample) -> dict[str, float]:
    semantic_top_three = set(example.semantic_order[:3])
    dictionary_top_three = set(range(min(3, len(example.semantic_order))))
    overlap = len(semantic_top_three & dictionary_top_three)
    return {
        "semantic-top-one-margin": score_gap(
            example.semantic_scores,
            example.semantic_order,
            0,
            1,
        ),
        "semantic-top-three-margin": score_gap(
            example.semantic_scores,
            example.semantic_order,
            2,
            3,
        ),
        "fused-top-three-margin": score_gap(
            example.scored.scores,
            example.fused_order,
            2,
            3,
        ),
        "rank-agreement": float(overlap),
        "rank-agreement-and-margin": overlap + score_gap(
            example.scored.scores,
            example.fused_order,
            2,
            3,
        ),
    }


def top_three_is_safe(example: RankedExample) -> bool:
    selected = fixed_top_k(example.scored.scores, 3)
    return any(
        example.scored.example["candidates"][index]["relevance"] in ACCEPTABLE_LABELS
        for index in selected
    )


def calibrate_threshold(
    examples: list[RankedExample],
    confidence_name: str,
) -> tuple[float, int]:
    values = [confidence_values(example)[confidence_name] for example in examples]
    thresholds = sorted(set(values), reverse=True)
    valid: list[tuple[int, float]] = [(0, float("inf"))]
    for threshold in thresholds:
        accepted = [
            example
            for example, value in zip(examples, values)
            if value >= threshold
        ]
        if all(top_three_is_safe(example) for example in accepted):
            valid.append((len(accepted), threshold))
    return max(valid, key=lambda item: (item[0], item[1]))


def selective_metrics(
    examples: list[RankedExample],
    confidence_name: str,
    threshold: float,
) -> dict[str, float | int | str]:
    selections = [
        fixed_top_k(example.scored.scores, 3)
        if confidence_values(example)[confidence_name] >= threshold
        else list(range(len(example.scored.scores)))
        for example in examples
    ]
    return {
        "confidence": confidence_name,
        "threshold": threshold,
        "top_three_cards": sum(len(selection) == 3 for selection in selections),
        **filtering_metrics([example.scored for example in examples], selections),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    args = parser.parse_args()
    path = ROOT / "data" / "processed" / f"{args.dataset}.jsonl"
    examples = [runtime_example(example) for example in read_jsonl(path)]
    semantic = load_ranker("e5-small-definition-only").score_many(examples)
    fused = [
        reciprocal_rank_fusion_scores(example, scores, 60, 0.5)
        for example, scores in zip(examples, semantic)
    ]
    ranked = [
        RankedExample(
            scored=ScoredExample(example=example, scores=fused_scores),
            semantic_scores=semantic_scores,
            semantic_order=ranking(semantic_scores),
            fused_order=ranking(fused_scores),
        )
        for example, semantic_scores, fused_scores in zip(examples, semantic, fused)
    ]
    calibration = [
        example
        for example in ranked
        if example.scored.example.get("benchmark_split") == "calibration"
    ]
    evaluation = [
        example
        for example in ranked
        if example.scored.example.get("benchmark_split") == "evaluation"
    ]
    confidence_names = list(confidence_values(calibration[0]))
    rows: list[dict[str, float | int | str]] = []
    for confidence_name in confidence_names:
        accepted, threshold = calibrate_threshold(calibration, confidence_name)
        calibration_metrics = selective_metrics(calibration, confidence_name, threshold)
        evaluation_metrics = selective_metrics(evaluation, confidence_name, threshold)
        rows.extend([
            {"slice": "calibration", "calibrated_top_three_cards": accepted, **calibration_metrics},
            {"slice": "evaluation", "calibrated_top_three_cards": accepted, **evaluation_metrics},
        ])
    calibration_rows = [row for row in rows if row["slice"] == "calibration"]
    selected = max(
        calibration_rows,
        key=lambda row: (
            int(row["top_three_cards"]),
            -float(row["mean_definitions_shown"]),
            str(row["confidence"]),
        ),
    )
    held_out = next(
        row
        for row in rows
        if row["slice"] == "evaluation" and row["confidence"] == selected["confidence"]
    )
    output = ROOT / "results" / f"{args.dataset}-selective-filter.csv"
    with output.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(
            destination,
            fieldnames=sorted({key for row in rows for key in row}),
        )
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps({
        "selected_on_calibration": selected,
        "held_out_evaluation": held_out,
        "all_policies": rows,
        "output": str(output.relative_to(ROOT)),
    }, indent=2))


if __name__ == "__main__":
    main()
