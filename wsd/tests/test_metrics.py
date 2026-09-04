from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from metrics import is_same_pos_hard_example, reader_metrics


class ReaderMetricsTest(unittest.TestCase):
    def test_same_pos_counts_top2_and_raw_margin(self) -> None:
        example = {
            "id": "example",
            "pos": "noun",
            "candidates": [
                {"part_of_speech": "verb", "relevance": "clearly_wrong"},
                {"part_of_speech": "noun", "relevance": "clearly_wrong"},
                {"part_of_speech": "noun", "relevance": "fits"},
            ],
        }
        self.assertTrue(is_same_pos_hard_example(example))
        metrics = reader_metrics([(example, [3.0, 2.4, 2.5], [0.9, 0.4, 0.5])])
        self.assertEqual(metrics["top1_acceptable_count"], 0)
        self.assertEqual(metrics["top2_acceptable_count"], 1)
        self.assertEqual(metrics["same_pos_pairwise_correct"], 1)
        self.assertEqual(metrics["same_pos_pairwise_comparisons"], 1)
        self.assertAlmostEqual(metrics["acceptable_wrong_margin_mean"], 0.1)


if __name__ == "__main__":
    unittest.main()
