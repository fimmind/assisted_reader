from __future__ import annotations

from collections.abc import Iterable


def ranking(scores: list[float]) -> list[int]:
    return sorted(range(len(scores)), key=lambda index: (-scores[index], index))


def exact_metrics(examples: Iterable[tuple[dict, list[float]]]) -> dict[str, float | int]:
    total = correct = 0
    reciprocal_rank = 0.0
    for example, scores in examples:
        order = ranking(scores)
        gold = set(example["gold"])
        total += 1
        if example["candidates"][order[0]]["sense_id"] in gold:
            correct += 1
        reciprocal_rank += next(1 / (position + 1) for position, index in enumerate(order) if example["candidates"][index]["sense_id"] in gold)
    return {"examples": total, "top1_accuracy": correct / total if total else 0.0, "mrr": reciprocal_rank / total if total else 0.0}


def reader_metrics(examples: Iterable[tuple[dict, list[float]]]) -> dict[str, float | int]:
    total = top1_acceptable = catastrophic_at_1 = catastrophic_at_3 = pairwise_total = pairwise_correct = 0
    reciprocal_rank = 0.0
    for example, scores in examples:
        order = ranking(scores)
        labels = [candidate.get("relevance") for candidate in example["candidates"]]
        if not all(labels):
            raise ValueError(f"Missing relevance annotation: {example['id']}")
        total += 1
        acceptable = {"fits", "plausible"}
        if labels[order[0]] in acceptable:
            top1_acceptable += 1
        if labels[order[0]] == "clearly_wrong":
            catastrophic_at_1 += 1
        if any(labels[index] == "clearly_wrong" for index in order[:3]):
            catastrophic_at_3 += 1
        reciprocal_rank += next(1 / (position + 1) for position, index in enumerate(order) if labels[index] in acceptable)
        for good_index, good_label in enumerate(labels):
            if good_label not in acceptable:
                continue
            for bad_index, bad_label in enumerate(labels):
                if bad_label == "clearly_wrong":
                    pairwise_total += 1
                    pairwise_correct += scores[good_index] > scores[bad_index]
    return {
        "examples": total,
        "top1_acceptable": top1_acceptable / total if total else 0.0,
        "catastrophic_error_rate_at_1": catastrophic_at_1 / total if total else 0.0,
        "catastrophic_error_rate_at_3": catastrophic_at_3 / total if total else 0.0,
        "mrr_first_acceptable": reciprocal_rank / total if total else 0.0,
        "pairwise_acceptable_over_wrong_accuracy": pairwise_correct / pairwise_total if pairwise_total else 0.0,
        "pairwise_comparisons": pairwise_total,
    }
