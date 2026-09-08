from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from filtering import (
    ScoredExample,
    calibrate_margin_threshold,
    conformal_margin_threshold,
    filtering_metrics,
    fixed_top_k,
    runtime_example,
    wilson_interval,
    within_best_margin,
    within_best_margin_unbounded,
)
from rankers import reciprocal_rank_fusion_scores


class FilteringTest(unittest.TestCase):
    def test_rrf_normalizes_dictionary_rank_after_pos_filtering(self) -> None:
        example = {
            "candidates": [
                {"original_rank": 20},
                {"original_rank": 21},
                {"original_rank": 22},
            ],
        }
        shifted = {
            "candidates": [
                {"original_rank": 0},
                {"original_rank": 1},
                {"original_rank": 2},
            ],
        }
        semantic_scores = [0.1, 0.3, 0.2]
        self.assertEqual(
            reciprocal_rank_fusion_scores(example, semantic_scores, 60, 0.25),
            reciprocal_rank_fusion_scores(shifted, semantic_scores, 60, 0.25),
        )

    def test_wilson_interval_contains_observed_rate(self) -> None:
        low, high = wilson_interval(3, 31)
        self.assertLess(low, 3 / 31)
        self.assertGreater(high, 3 / 31)

    def test_conformal_margin_retains_calibrated_acceptable_definition(self) -> None:
        examples = [
            ScoredExample(
                example={
                    "id": "one",
                    "candidates": [
                        {"relevance": "clearly_wrong"},
                        {"relevance": "fits"},
                    ],
                },
                scores=[1.0, 0.8],
            ),
            ScoredExample(
                example={
                    "id": "two",
                    "candidates": [
                        {"relevance": "plausible"},
                        {"relevance": "clearly_wrong"},
                    ],
                },
                scores=[0.7, 0.6],
            ),
        ]
        threshold = conformal_margin_threshold(examples, 0.5)
        selections = [
            within_best_margin_unbounded(item.scores, threshold)
            for item in examples
        ]
        self.assertEqual(
            int(filtering_metrics(examples, selections)["unsafe_exclusions"]),
            0,
        )

    def test_runtime_example_uses_matching_pos_group(self) -> None:
        example = {
            "pos": "noun",
            "candidates": [
                {"part_of_speech": "verb"},
                {"part_of_speech": "noun"},
                {"part_of_speech": "noun"},
            ],
        }
        visible = runtime_example(example)
        self.assertEqual(len(visible["candidates"]), 2)
        self.assertEqual(len(example["candidates"]), 3)

    def test_metrics_measure_safety_and_reduction(self) -> None:
        example = {
            "id": "example",
            "candidates": [
                {"relevance": "clearly_wrong"},
                {"relevance": "fits"},
                {"relevance": "plausible"},
                {"relevance": "clearly_wrong"},
            ],
        }
        scored = [ScoredExample(example=example, scores=[0.9, 0.8, 0.7, 0.6])]
        metrics = filtering_metrics(scored, [[0, 1]])
        self.assertEqual(metrics["unsafe_exclusions"], 0)
        self.assertEqual(metrics["all_fits_hidden"], 0)
        self.assertAlmostEqual(metrics["candidate_reduction"], 0.5)
        self.assertAlmostEqual(metrics["acceptable_definition_recall"], 0.5)
        self.assertAlmostEqual(metrics["retained_definition_precision"], 0.5)

    def test_margin_filter_and_calibration_preserve_top_three_safety(self) -> None:
        examples = [
            ScoredExample(
                example={
                    "id": "one",
                    "candidates": [
                        {"relevance": "fits"},
                        {"relevance": "clearly_wrong"},
                        {"relevance": "clearly_wrong"},
                    ],
                },
                scores=[1.0, 0.0, -1.0],
            ),
            ScoredExample(
                example={
                    "id": "two",
                    "candidates": [
                        {"relevance": "clearly_wrong"},
                        {"relevance": "fits"},
                        {"relevance": "clearly_wrong"},
                    ],
                },
                scores=[1.0, 0.9, 0.0],
            ),
        ]
        threshold = calibrate_margin_threshold(examples, 3)
        selections = [within_best_margin(item.scores, 3, threshold) for item in examples]
        self.assertEqual(int(filtering_metrics(examples, selections)["unsafe_exclusions"]), 0)
        self.assertLess(float(filtering_metrics(examples, selections)["mean_definitions_shown"]), 3)
        self.assertEqual(fixed_top_k(examples[0].scores, 2), [0, 1])


if __name__ == "__main__":
    unittest.main()
