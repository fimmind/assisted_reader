from __future__ import annotations

import argparse
import csv
import json
from dataclasses import dataclass
from itertools import product
from pathlib import Path

from filtering import ScoredExample, filtering_metrics, runtime_example
from metrics import ranking
from rankers import load_ranker


ROOT = Path(__file__).resolve().parents[1]
SOURCE_NAMES = ("dictionary", "e5", "arctic")


@dataclass(frozen=True)
class RankedExample:
    scored: ScoredExample
    rankings: dict[str, list[int]]


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def next_unselected(order: list[int], selected: list[int]) -> int:
    for index in order:
        if index not in selected:
            return index
    raise ValueError("A source ranking has no unselected candidate")


def interleaved_selection(
    rankings: dict[str, list[int]],
    source_sequence: tuple[str, ...],
) -> list[int]:
    selected: list[int] = []
    for source_name in source_sequence:
        selected.append(next_unselected(rankings[source_name], selected))
    return selected


def policy_metrics(
    examples: list[RankedExample],
    source_sequence: tuple[str, ...],
) -> dict[str, float | int | str]:
    scored = [example.scored for example in examples]
    selections = [
        interleaved_selection(example.rankings, source_sequence)
        for example in examples
    ]
    return {
        "policy": "-".join(source_sequence),
        **filtering_metrics(scored, selections),
    }


def selection_key(row: dict[str, float | int | str]) -> tuple[int, int, float, float, str]:
    return (
        int(row["unsafe_exclusions"]),
        int(row["all_fits_hidden"]),
        -float(row["acceptable_definition_recall"]),
        -float(row["retained_definition_precision"]),
        str(row["policy"]),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    args = parser.parse_args()

    path = ROOT / "data" / "processed" / f"{args.dataset}.jsonl"
    examples = [runtime_example(example) for example in read_jsonl(path)]
    ranker_names = {
        "dictionary": "mfs",
        "e5": "e5-small-definition-only",
        "arctic": "arctic-embed-xs",
    }
    scores_by_source = {
        source_name: load_ranker(ranker_name).score_many(examples)
        for source_name, ranker_name in ranker_names.items()
    }
    ranked_examples = [
        RankedExample(
            scored=ScoredExample(
                example=example,
                scores=scores_by_source["dictionary"][example_index],
            ),
            rankings={
                source_name: ranking(scores[example_index])
                for source_name, scores in scores_by_source.items()
            },
        )
        for example_index, example in enumerate(examples)
    ]
    calibration = [
        example
        for example in ranked_examples
        if example.scored.example.get("benchmark_split") == "calibration"
    ]
    evaluation = [
        example
        for example in ranked_examples
        if example.scored.example.get("benchmark_split") == "evaluation"
    ]
    if not calibration or not evaluation:
        raise ValueError("Dataset must contain non-empty calibration and evaluation splits")

    sequences = list(product(SOURCE_NAMES, repeat=3))
    calibration_rows = [policy_metrics(calibration, sequence) for sequence in sequences]
    calibration_rows.sort(key=selection_key)
    selected_policy = tuple(str(calibration_rows[0]["policy"]).split("-"))
    evaluation_row = policy_metrics(evaluation, selected_policy)

    output = ROOT / "results" / f"{args.dataset}-ensemble-search.csv"
    output.parent.mkdir(exist_ok=True)
    with output.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(
            destination,
            fieldnames=sorted({key for row in calibration_rows for key in row}),
        )
        writer.writeheader()
        writer.writerows(calibration_rows)

    print(json.dumps({
        "selected_on_calibration": calibration_rows[0],
        "held_out_evaluation": evaluation_row,
        "calibration_runner_up": calibration_rows[1:6],
        "output": str(output.relative_to(ROOT)),
    }, indent=2))


if __name__ == "__main__":
    main()
