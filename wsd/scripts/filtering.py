from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from math import ceil, inf, sqrt

from metrics import ACCEPTABLE_LABELS, ranking


@dataclass(frozen=True)
class ScoredExample:
    example: dict
    scores: list[float]


def wilson_interval(successes: int, total: int) -> tuple[float, float]:
    if successes < 0 or successes > total or total < 0:
        raise ValueError(f"Invalid proportion counts: successes={successes}, total={total}")
    if total == 0:
        return 0.0, 0.0
    z = 1.959963984540054
    observed = successes / total
    denominator = 1 + z * z / total
    center = (observed + z * z / (2 * total)) / denominator
    half_width = z * sqrt(
        observed * (1 - observed) / total + z * z / (4 * total * total)
    ) / denominator
    return max(0.0, center - half_width), min(1.0, center + half_width)


def runtime_example(example: dict) -> dict:
    """Return the definition candidates the current reader would display."""
    target_pos = example.get("pos")
    if not isinstance(target_pos, str) or not target_pos:
        raise ValueError(f"Example has no target POS: {example.get('id')}")
    matching = [
        candidate
        for candidate in example["candidates"]
        if candidate.get("part_of_speech", candidate.get("pos")) == target_pos
    ]
    if not matching:
        raise ValueError(f"Example has no candidates for target POS: {example.get('id')}")
    return {**example, "candidates": matching}


def fixed_top_k(scores: list[float], maximum: int) -> list[int]:
    if maximum < 1:
        raise ValueError(f"maximum must be positive, got {maximum}")
    return ranking(scores)[:maximum]


def within_best_margin(scores: list[float], maximum: int, threshold: float) -> list[int]:
    if threshold < 0:
        raise ValueError(f"threshold must be non-negative, got {threshold}")
    order = ranking(scores)[:maximum]
    if not order:
        raise ValueError("Cannot filter an empty candidate list")
    best = scores[order[0]]
    selected = [index for index in order if best - scores[index] <= threshold]
    return selected or [order[0]]


def within_best_margin_unbounded(scores: list[float], threshold: float) -> list[int]:
    if threshold < 0:
        raise ValueError(f"threshold must be non-negative, got {threshold}")
    order = ranking(scores)
    if not order:
        raise ValueError("Cannot filter an empty candidate list")
    best = scores[order[0]]
    return [index for index in order if best - scores[index] <= threshold]


def conformal_margin_threshold(
    scored: list[ScoredExample],
    miscoverage_rate: float,
) -> float:
    if not scored:
        raise ValueError("Cannot calibrate a conformal filter without examples")
    if miscoverage_rate <= 0 or miscoverage_rate >= 1:
        raise ValueError(
            f"miscoverage_rate must be between zero and one, got {miscoverage_rate}"
        )
    nonconformity: list[float] = []
    for item in scored:
        labels = [candidate.get("relevance") for candidate in item.example["candidates"]]
        acceptable_scores = [
            score
            for score, label in zip(item.scores, labels)
            if label in ACCEPTABLE_LABELS
        ]
        if not acceptable_scores:
            raise ValueError(
                f"Example has no acceptable definition: {item.example.get('id')}"
            )
        nonconformity.append(max(item.scores) - max(acceptable_scores))
    quantile_rank = ceil((len(scored) + 1) * (1 - miscoverage_rate))
    if quantile_rank > len(nonconformity):
        return inf
    return sorted(nonconformity)[quantile_rank - 1]


def conformal_all_acceptable_margin_threshold(
    scored: list[ScoredExample],
    miscoverage_rate: float,
) -> float:
    """Calibrate a margin intended to retain every acceptable definition."""
    if not scored:
        raise ValueError("Cannot calibrate an all-acceptable filter without examples")
    if miscoverage_rate <= 0 or miscoverage_rate >= 1:
        raise ValueError(f"Miscoverage rate must be between zero and one: {miscoverage_rate}")
    nonconformity: list[float] = []
    for item in scored:
        acceptable_scores = [
            score
            for score, candidate in zip(item.scores, item.example["candidates"])
            if candidate.get("relevance") in ACCEPTABLE_LABELS
        ]
        if not acceptable_scores:
            raise ValueError(f"Example has no acceptable definition: {item.example.get('id')}")
        nonconformity.append(max(item.scores) - min(acceptable_scores))
    quantile_rank = ceil((len(scored) + 1) * (1 - miscoverage_rate))
    if quantile_rank > len(nonconformity):
        return inf
    return sorted(nonconformity)[quantile_rank - 1]


def filtering_metrics(
    scored: Iterable[ScoredExample],
    selections: Iterable[list[int]],
) -> dict[str, float | int]:
    examples = list(scored)
    chosen = list(selections)
    if len(examples) != len(chosen):
        raise ValueError(
            f"Expected one selection per example, got {len(chosen)} selections for {len(examples)} examples"
        )

    input_candidates = output_candidates = 0
    acceptable_total = acceptable_retained = 0
    wrong_total = wrong_retained = 0
    unsafe = all_fits_hidden = any_acceptable_hidden = perfect = 0
    output_counts: dict[int, int] = {}
    for item, indices in zip(examples, chosen):
        labels = [candidate.get("relevance") for candidate in item.example["candidates"]]
        if not labels or not all(label in ACCEPTABLE_LABELS | {"clearly_wrong"} for label in labels):
            raise ValueError(f"Invalid relevance labels: {item.example.get('id')}")
        if not indices or len(indices) > len(labels) or len(indices) != len(set(indices)):
            raise ValueError(f"Invalid retained indices for {item.example.get('id')}: {indices}")
        if any(index < 0 or index >= len(labels) for index in indices):
            raise IndexError(f"Retained index outside candidate list for {item.example.get('id')}: {indices}")

        retained_labels = [labels[index] for index in indices]
        acceptable_here = sum(label in ACCEPTABLE_LABELS for label in labels)
        retained_acceptable_here = sum(label in ACCEPTABLE_LABELS for label in retained_labels)
        fits_here = sum(label == "fits" for label in labels)
        retained_fits_here = sum(label == "fits" for label in retained_labels)
        if acceptable_here == 0:
            raise ValueError(f"Runtime candidate set has no acceptable definition: {item.example.get('id')}")

        input_candidates += len(labels)
        output_candidates += len(indices)
        acceptable_total += acceptable_here
        acceptable_retained += retained_acceptable_here
        wrong_total += len(labels) - acceptable_here
        wrong_retained += len(indices) - retained_acceptable_here
        unsafe += retained_acceptable_here == 0
        any_acceptable_hidden += retained_acceptable_here < acceptable_here
        all_fits_hidden += fits_here > 0 and retained_fits_here == 0
        perfect += all(label in ACCEPTABLE_LABELS for label in retained_labels)
        output_counts[len(indices)] = output_counts.get(len(indices), 0) + 1

    total = len(examples)
    unsafe_low, unsafe_high = wilson_interval(unsafe, total)
    return {
        "examples": total,
        "input_candidates": input_candidates,
        "output_candidates": output_candidates,
        "mean_definitions_shown": output_candidates / total if total else 0.0,
        "candidate_reduction": 1 - output_candidates / input_candidates if input_candidates else 0.0,
        "unsafe_exclusions": unsafe,
        "any_acceptable_hidden": any_acceptable_hidden,
        "any_acceptable_hidden_rate": any_acceptable_hidden / total if total else 0.0,
        "unsafe_exclusion_rate": unsafe / total if total else 0.0,
        "unsafe_exclusion_rate_ci95_low": unsafe_low,
        "unsafe_exclusion_rate_ci95_high": unsafe_high,
        "all_fits_hidden": all_fits_hidden,
        "all_fits_hidden_rate": all_fits_hidden / total if total else 0.0,
        "acceptable_definition_recall": (
            acceptable_retained / acceptable_total if acceptable_total else 0.0
        ),
        "retained_definition_precision": (
            acceptable_retained / output_candidates if output_candidates else 0.0
        ),
        "wrong_definition_suppression": 1 - wrong_retained / wrong_total if wrong_total else 0.0,
        "all_retained_acceptable": perfect,
        "all_retained_acceptable_rate": perfect / total if total else 0.0,
        "show_one_count": output_counts.get(1, 0),
        "show_two_count": output_counts.get(2, 0),
        "show_three_count": output_counts.get(3, 0),
        "show_more_than_three_count": sum(
            count for size, count in output_counts.items() if size > 3
        ),
        "maximum_definitions_shown": max(output_counts, default=0),
    }


def calibrate_margin_threshold(
    scored: list[ScoredExample],
    maximum: int,
) -> float:
    if not scored:
        raise ValueError("Cannot calibrate an adaptive filter without examples")
    top_k_selections = [fixed_top_k(item.scores, maximum) for item in scored]
    baseline_unsafe = int(filtering_metrics(scored, top_k_selections)["unsafe_exclusions"])
    thresholds = {0.0, inf}
    for item in scored:
        order = ranking(item.scores)[:maximum]
        best = item.scores[order[0]]
        thresholds.update(best - item.scores[index] for index in order[1:])

    valid: list[tuple[float, float, float]] = []
    for threshold in sorted(thresholds):
        selections = [within_best_margin(item.scores, maximum, threshold) for item in scored]
        metrics = filtering_metrics(scored, selections)
        if int(metrics["unsafe_exclusions"]) <= baseline_unsafe:
            valid.append((
                float(metrics["mean_definitions_shown"]),
                -float(metrics["acceptable_definition_recall"]),
                threshold,
            ))
    if not valid:
        raise RuntimeError("No margin threshold matched the fixed Top-K safety baseline")
    return min(valid)[2]
