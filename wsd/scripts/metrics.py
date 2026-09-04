from __future__ import annotations

from collections.abc import Iterable


ACCEPTABLE_LABELS = {"fits", "plausible"}


def ranking(scores: list[float]) -> list[int]:
    return sorted(range(len(scores)), key=lambda index: (-scores[index], index))


def exact_metrics(examples: Iterable[tuple[dict, list[float]]]) -> dict[str, float | int | str]:
    total = correct = mapped = mapping_applicable = 0
    reciprocal_rank = 0.0
    for example, scores in examples:
        order = ranking(scores)
        gold = set(example["gold"])
        gold_candidates = [candidate for candidate in example["candidates"] if candidate["sense_id"] in gold]
        if any("wordnet_synset" in candidate for candidate in gold_candidates):
            mapping_applicable += 1
            mapped += all(candidate.get("wordnet_synset") is not None for candidate in gold_candidates)
        total += 1
        if example["candidates"][order[0]]["sense_id"] in gold:
            correct += 1
        reciprocal_rank += next(1 / (position + 1) for position, index in enumerate(order) if example["candidates"][index]["sense_id"] in gold)
    return {
        "examples": total,
        "top1_correct": correct,
        "top1_accuracy": correct / total if total else 0.0,
        "mrr": reciprocal_rank / total if total else 0.0,
        "mapped_gold_examples": mapped if mapping_applicable else "",
        "mapping_coverage": mapped / mapping_applicable if mapping_applicable else "",
    }


def matching_pos_candidate_count(example: dict) -> int:
    target_pos = example.get("pos")
    if not isinstance(target_pos, str) or not target_pos:
        return 0
    return sum(
        candidate.get("part_of_speech", candidate.get("pos")) == target_pos
        for candidate in example["candidates"]
    )


def is_same_pos_hard_example(example: dict) -> bool:
    return matching_pos_candidate_count(example) >= 2


def reader_metrics(
    examples: Iterable[tuple[dict, list[float]] | tuple[dict, list[float], list[float]]],
) -> dict[str, float | int]:
    total = top1_acceptable = top2_acceptable = catastrophic_at_1 = catastrophic_at_3 = 0
    pairwise_total = pairwise_correct = same_pos_pairwise_total = same_pos_pairwise_correct = 0
    margin_count = negative_margin_count = 0
    margin_sum = 0.0
    reciprocal_rank = 0.0
    for item in examples:
        example, scores = item[0], item[1]
        raw_scores = item[2] if len(item) == 3 else scores
        order = ranking(scores)
        labels = [candidate.get("relevance") for candidate in example["candidates"]]
        if not all(labels):
            raise ValueError(f"Missing relevance annotation: {example['id']}")
        total += 1
        if labels[order[0]] in ACCEPTABLE_LABELS:
            top1_acceptable += 1
        if any(labels[index] in ACCEPTABLE_LABELS for index in order[:2]):
            top2_acceptable += 1
        if labels[order[0]] == "clearly_wrong":
            catastrophic_at_1 += 1
        if any(labels[index] == "clearly_wrong" for index in order[:3]):
            catastrophic_at_3 += 1
        reciprocal_rank += next(1 / (position + 1) for position, index in enumerate(order) if labels[index] in ACCEPTABLE_LABELS)
        target_pos = example.get("pos")
        acceptable_matching_scores: list[float] = []
        wrong_matching_scores: list[float] = []
        for good_index, good_label in enumerate(labels):
            if good_label not in ACCEPTABLE_LABELS:
                continue
            for bad_index, bad_label in enumerate(labels):
                if bad_label == "clearly_wrong":
                    pairwise_total += 1
                    pairwise_correct += scores[good_index] > scores[bad_index]
                    good_pos = example["candidates"][good_index].get("part_of_speech", example["candidates"][good_index].get("pos"))
                    bad_pos = example["candidates"][bad_index].get("part_of_speech", example["candidates"][bad_index].get("pos"))
                    if target_pos and good_pos == target_pos and bad_pos == target_pos:
                        same_pos_pairwise_total += 1
                        same_pos_pairwise_correct += raw_scores[good_index] > raw_scores[bad_index]
        if target_pos:
            for index, label in enumerate(labels):
                candidate_pos = example["candidates"][index].get("part_of_speech", example["candidates"][index].get("pos"))
                if candidate_pos != target_pos:
                    continue
                if label in ACCEPTABLE_LABELS:
                    acceptable_matching_scores.append(raw_scores[index])
                elif label == "clearly_wrong":
                    wrong_matching_scores.append(raw_scores[index])
        if acceptable_matching_scores and wrong_matching_scores:
            margin = max(acceptable_matching_scores) - max(wrong_matching_scores)
            margin_sum += margin
            margin_count += 1
            negative_margin_count += margin < 0
    return {
        "examples": total,
        "top1_acceptable_count": top1_acceptable,
        "top1_acceptable": top1_acceptable / total if total else 0.0,
        "top2_acceptable_count": top2_acceptable,
        "top2_acceptable": top2_acceptable / total if total else 0.0,
        "catastrophic_errors_at_1": catastrophic_at_1,
        "catastrophic_error_rate_at_1": catastrophic_at_1 / total if total else 0.0,
        "catastrophic_errors_at_3": catastrophic_at_3,
        "catastrophic_error_rate_at_3": catastrophic_at_3 / total if total else 0.0,
        "mrr_first_acceptable": reciprocal_rank / total if total else 0.0,
        "pairwise_acceptable_over_wrong_accuracy": pairwise_correct / pairwise_total if pairwise_total else 0.0,
        "pairwise_comparisons": pairwise_total,
        "same_pos_pairwise_accuracy": same_pos_pairwise_correct / same_pos_pairwise_total if same_pos_pairwise_total else 0.0,
        "same_pos_pairwise_correct": same_pos_pairwise_correct,
        "same_pos_pairwise_comparisons": same_pos_pairwise_total,
        "acceptable_wrong_margin_mean": margin_sum / margin_count if margin_count else 0.0,
        "acceptable_wrong_margin_examples": margin_count,
        "acceptable_wrong_negative_margin_examples": negative_margin_count,
    }
