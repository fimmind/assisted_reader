from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from rankers import MODEL_ROOT, WordNetSenseEmbeddingRanker, marked_context, unique_inputs


class RankerInputTest(unittest.TestCase):
    def test_marked_context_uses_exact_occurrence(self) -> None:
        example = {
            "id": "second-bank",
            "context": "The bank repaired the river bank.",
            "target": "bank",
            "target_start": 28,
        }
        self.assertEqual(
            marked_context(example),
            "The bank repaired the river [TGT]bank[/TGT].",
        )

    def test_repeated_target_requires_offset(self) -> None:
        example = {
            "id": "ambiguous-bank",
            "context": "The bank repaired the bank.",
            "target": "bank",
        }
        with self.assertRaisesRegex(ValueError, "requires target_start"):
            marked_context(example)

    def test_unique_inputs_preserves_order_and_inverse(self) -> None:
        unique, inverse = unique_inputs(["one", "two", "one", "three", "two"])
        self.assertEqual(unique, ["one", "two", "three"])
        self.assertEqual(inverse, [0, 1, 0, 2, 1])

    @unittest.skipUnless(
        (MODEL_ROOT / "wordnet-sense-embedding" / "model.safetensors").is_file()
        and importlib.util.find_spec("sentence_transformers") is not None,
        "wordnet-sense-embedding checkpoint or dependencies are unavailable",
    )
    def test_wordnet_encoder_passes_target_mask_to_pooling(self) -> None:
        ranker = WordNetSenseEmbeddingRanker()
        observed = {"word_mask": False}

        def inspect_pooling_input(module: object, arguments: tuple[dict]) -> None:
            observed["word_mask"] = "word_mask" in arguments[0]

        hook = ranker.model[1].register_forward_pre_hook(inspect_pooling_input)
        try:
            ranker.model.encode(
                ["'bank': the [TGT]bank[/TGT] approved a loan"],
                normalize_embeddings=True,
                show_progress_bar=False,
            )
        finally:
            hook.remove()
        self.assertTrue(observed["word_mask"])


if __name__ == "__main__":
    unittest.main()
