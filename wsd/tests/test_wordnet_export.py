from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from export_wordnet_lexicon import BUCKET_COUNT, export_assets, hash_word, source_words


def write_source(directory: Path) -> Path:
    """Create a complete small lexicon in the real bucket format."""
    bucket_id = hash_word("memoranda") % BUCKET_COUNT
    for index in range(BUCKET_COUNT):
        entries = [{"word": "memoranda", "senses": []}] if index == bucket_id else []
        (directory / f"{index:04d}.json").write_text(json.dumps(entries), encoding="utf-8")
    (directory / "index.json").write_text(json.dumps({
        "schemaVersion": 5,
        "bucketAlgorithm": "fnv1a-32",
        "bucketCount": BUCKET_COUNT,
        "entryCount": 1,
    }), encoding="utf-8")
    return directory / f"{bucket_id:04d}.json"


class WordNetExportTest(unittest.TestCase):
    def test_complete_source_and_missing_bucket(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            word_bucket = write_source(directory)
            self.assertEqual(source_words(directory), {"memoranda"})
            word_bucket.unlink()
            with self.assertRaises(FileNotFoundError):
                source_words(directory)

    def test_wrong_source_count(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            word_bucket = write_source(directory)
            word_bucket.write_text("[]", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "entry count mismatch"):
                source_words(directory)

    def test_malformed_entry_is_not_silently_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            word_bucket = write_source(directory)
            word_bucket.write_text('[{"word":null}]', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Invalid Wiktionary entry"):
                source_words(directory)

    def test_output_cannot_overwrite_wiktionary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            word_bucket = write_source(directory)
            original = word_bucket.read_bytes()
            with self.assertRaisesRegex(ValueError, "must not overwrite"):
                export_assets(directory / "unused.zip", directory, directory)
            self.assertEqual(word_bucket.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
