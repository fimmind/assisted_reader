from __future__ import annotations

import argparse
import csv
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from filtering import ScoredExample, filtering_metrics, fixed_top_k, runtime_example
from metrics import ACCEPTABLE_LABELS, ranking
from rankers import load_ranker


ROOT = Path(__file__).resolve().parents[1]
TOKEN_RE = re.compile(r"[a-z]+(?:'[a-z]+)?")


@dataclass(frozen=True)
class FeatureSet:
    name: str
    model_names: tuple[str, ...]


@dataclass(frozen=True)
class PreparedExample:
    example: dict
    features: np.ndarray
    labels: np.ndarray


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def reciprocal_ranks(scores: list[float]) -> list[float]:
    positions = {index: position for position, index in enumerate(ranking(scores), start=1)}
    return [1 / positions[index] for index in range(len(scores))]


def lexical_overlap_scores(example: dict) -> list[float]:
    context = set(TOKEN_RE.findall(example["context"].lower()))
    context -= {example["target"].lower(), example["lemma"].lower()}
    return [
        len(context & set(TOKEN_RE.findall(candidate["gloss"].lower())))
        / math.sqrt(max(1, len(TOKEN_RE.findall(candidate["gloss"].lower()))))
        for candidate in example["candidates"]
    ]


def candidate_features(
    example: dict,
    model_scores: dict[str, list[float]],
) -> np.ndarray:
    count = len(example["candidates"])
    lexical_scores = lexical_overlap_scores(example)
    feature_columns: list[list[float]] = [
        [1 / (index + 1) for index in range(count)],
        [(index + 1) / count for index in range(count)],
        lexical_scores,
        reciprocal_ranks(lexical_scores),
        [math.log1p(len(TOKEN_RE.findall(candidate["gloss"].lower()))) for candidate in example["candidates"]],
        [math.log1p(count)] * count,
    ]
    for scores in model_scores.values():
        best = max(scores)
        feature_columns.extend([
            scores,
            [score - best for score in scores],
            reciprocal_ranks(scores),
        ])
    return np.column_stack(feature_columns)


def prepare_examples(
    examples: list[dict],
    feature_set: FeatureSet,
    scores_by_model: dict[str, list[list[float]]],
) -> list[PreparedExample]:
    return [
        PreparedExample(
            example=example,
            features=candidate_features(
                example,
                {
                    model_name: scores_by_model[model_name][example_index]
                    for model_name in feature_set.model_names
                },
            ),
            labels=np.asarray([
                int(candidate["relevance"] in ACCEPTABLE_LABELS)
                for candidate in example["candidates"]
            ]),
        )
        for example_index, example in enumerate(examples)
    ]


def fit_model(
    examples: list[PreparedExample],
    regularization: float,
    positive_weight: float,
) -> Pipeline:
    features = np.concatenate([example.features for example in examples])
    labels = np.concatenate([example.labels for example in examples])
    model = Pipeline([
        ("scale", StandardScaler()),
        ("classifier", LogisticRegression(
            C=regularization,
            class_weight={0: 1.0, 1: positive_weight},
            max_iter=2_000,
            random_state=0,
        )),
    ])
    model.fit(features, labels)
    return model


def score_examples(model: Pipeline, examples: list[PreparedExample]) -> list[ScoredExample]:
    return [
        ScoredExample(
            example=example.example,
            scores=model.predict_proba(example.features)[:, 1].tolist(),
        )
        for example in examples
    ]


def top_three_metrics(scored: list[ScoredExample]) -> dict[str, float | int]:
    return filtering_metrics(scored, [fixed_top_k(item.scores, 3) for item in scored])


def cross_validated_metrics(
    examples: list[PreparedExample],
    regularization: float,
    positive_weight: float,
) -> dict[str, float | int]:
    groups = np.asarray([example.example["lemma"] for example in examples])
    splitter = GroupKFold(n_splits=5)
    out_of_fold: list[ScoredExample | None] = [None] * len(examples)
    placeholder = np.zeros(len(examples))
    for train_indices, validation_indices in splitter.split(placeholder, groups=groups):
        training = [examples[int(index)] for index in train_indices]
        validation = [examples[int(index)] for index in validation_indices]
        model = fit_model(training, regularization, positive_weight)
        predictions = score_examples(model, validation)
        for index, prediction in zip(validation_indices, predictions):
            out_of_fold[int(index)] = prediction
    if any(item is None for item in out_of_fold):
        raise RuntimeError("Cross-validation did not score every calibration example")
    return top_three_metrics([item for item in out_of_fold if item is not None])


def selection_key(row: dict[str, float | int | str]) -> tuple[int, int, float, int, float]:
    model_count = len(str(row["feature_set"]).split("+"))
    return (
        int(row["unsafe_exclusions"]),
        int(row["all_fits_hidden"]),
        -float(row["acceptable_definition_recall"]),
        model_count,
        float(row["regularization"]),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    args = parser.parse_args()

    path = ROOT / "data" / "processed" / f"{args.dataset}.jsonl"
    examples = [runtime_example(example) for example in read_jsonl(path)]
    feature_sets = [
        FeatureSet(name="e5", model_names=("e5-small-definition-only",)),
        FeatureSet(name="arctic", model_names=("arctic-embed-xs",)),
        FeatureSet(
            name="e5+arctic",
            model_names=("e5-small-definition-only", "arctic-embed-xs"),
        ),
    ]
    required_models = sorted({name for item in feature_sets for name in item.model_names})
    scores_by_model = {
        model_name: load_ranker(model_name).score_many(examples)
        for model_name in required_models
    }
    calibration_indices = [
        index
        for index, example in enumerate(examples)
        if example.get("benchmark_split") == "calibration"
    ]
    evaluation_indices = [
        index
        for index, example in enumerate(examples)
        if example.get("benchmark_split") == "evaluation"
    ]
    if not calibration_indices or not evaluation_indices:
        raise ValueError("Dataset must contain non-empty calibration and evaluation splits")

    grid_rows: list[dict[str, float | int | str]] = []
    prepared_by_name: dict[str, list[PreparedExample]] = {}
    for feature_set in feature_sets:
        prepared = prepare_examples(examples, feature_set, scores_by_model)
        prepared_by_name[feature_set.name] = prepared
        calibration = [prepared[index] for index in calibration_indices]
        for regularization in (0.01, 0.1, 1.0, 10.0):
            for positive_weight in (1.0, 2.0, 4.0, 8.0):
                metrics = cross_validated_metrics(
                    calibration,
                    regularization,
                    positive_weight,
                )
                grid_rows.append({
                    "feature_set": feature_set.name,
                    "regularization": regularization,
                    "positive_weight": positive_weight,
                    **metrics,
                })
    grid_rows.sort(key=selection_key)
    selected = grid_rows[0]
    prepared = prepared_by_name[str(selected["feature_set"])]
    calibration = [prepared[index] for index in calibration_indices]
    evaluation = [prepared[index] for index in evaluation_indices]
    model = fit_model(
        calibration,
        float(selected["regularization"]),
        float(selected["positive_weight"]),
    )
    held_out = top_three_metrics(score_examples(model, evaluation))

    output = ROOT / "results" / f"{args.dataset}-learned-filter-search.csv"
    output.parent.mkdir(exist_ok=True)
    with output.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(
            destination,
            fieldnames=sorted({key for row in grid_rows for key in row}),
        )
        writer.writeheader()
        writer.writerows(grid_rows)

    classifier = model.named_steps["classifier"]
    scaler = model.named_steps["scale"]
    print(json.dumps({
        "selected_by_grouped_cross_validation": selected,
        "held_out_evaluation": held_out,
        "runner_up": grid_rows[1:6],
        "deployment_parameters": {
            "coefficient": classifier.coef_[0].tolist(),
            "intercept": classifier.intercept_.tolist(),
            "feature_mean": scaler.mean_.tolist(),
            "feature_scale": scaler.scale_.tolist(),
        },
        "output": str(output.relative_to(ROOT)),
    }, indent=2))


if __name__ == "__main__":
    main()
