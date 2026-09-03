from __future__ import annotations

import sys
from abc import ABC, abstractmethod
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
MODEL_ROOT = ROOT / ".cache" / "models"


class Ranker(ABC):
    name: str

    @abstractmethod
    def score(self, example: dict) -> list[float]:
        raise NotImplementedError

    def score_many(self, examples: list[dict]) -> list[list[float]]:
        return [self.score(example) for example in examples]


class MfsRanker(Ranker):
    name = "mfs"

    def score(self, example: dict) -> list[float]:
        return [float(candidate.get("frequency", 0)) for candidate in example["candidates"]]


class PosMfsRanker(MfsRanker):
    name = "pos-mfs"


def candidate_pos(candidate: dict) -> str | None:
    value = candidate.get("part_of_speech", candidate.get("pos"))
    return value if isinstance(value, str) else None


def apply_pos_first(example: dict, scores: list[float]) -> list[float]:
    """Promote the inferred POS without discarding any candidate definition."""
    target_pos = example.get("pos")
    if not isinstance(target_pos, str) or not target_pos:
        return scores
    # Cosine similarity is bounded by [-1, 1], so this preserves semantic
    # ordering within the POS while always placing matching POS first.
    return [score + 2.1 if candidate_pos(candidate) == target_pos else score for candidate, score in zip(example["candidates"], scores)]


class PosOrderRanker(Ranker):
    name = "pos-order"

    def score(self, example: dict) -> list[float]:
        return apply_pos_first(example, [0.0] * len(example["candidates"]))


class EmbeddingRanker(Ranker):
    def score_many(self, examples: list[dict]) -> list[list[float]]:
        contexts = [self.context_input(example) for example in examples]
        glosses = [self.gloss_input(example, candidate) for example in examples for candidate in example["candidates"]]
        embeddings = np.asarray(self.model.encode(contexts + glosses, batch_size=256, normalize_embeddings=True, show_progress_bar=False))
        context_embeddings = embeddings[:len(examples)]
        gloss_embeddings = embeddings[len(examples):]
        scores: list[list[float]] = []
        offset = 0
        for example, context in zip(examples, context_embeddings):
            count = len(example["candidates"])
            scores.append((gloss_embeddings[offset:offset + count] @ context).tolist())
            offset += count
        return scores


class E5SmallRanker(EmbeddingRanker):
    name = "e5-small"

    def __init__(self) -> None:
        from sentence_transformers import SentenceTransformer

        model_path = MODEL_ROOT / "e5-small"
        if not model_path.exists():
            raise FileNotFoundError("E5-small is missing. Run: uv run python scripts/download_models.py e5-small")
        self.model = SentenceTransformer(str(model_path), local_files_only=True)

    @staticmethod
    def context_input(example: dict) -> str:
        return f"query: Target word: {example['target']}. Context: {example['context']}"

    @staticmethod
    def gloss_input(example: dict, candidate: dict) -> str:
        return f"passage: {example['lemma']}. {example['pos']}. {candidate['gloss']}"

    def score(self, example: dict) -> list[float]:
        inputs = [self.context_input(example)] + [self.gloss_input(example, candidate) for candidate in example["candidates"]]
        embeddings = self.model.encode(inputs, normalize_embeddings=True, show_progress_bar=False)
        return (embeddings[1:] @ embeddings[0]).tolist()


class WordNetSenseEmbeddingRanker(EmbeddingRanker):
    name = "wordnet-sense-embedding"

    def __init__(self) -> None:
        model_path = MODEL_ROOT / "wordnet-sense-embedding"
        if not model_path.exists():
            raise FileNotFoundError("WordNet sense embedding is missing. Run: uv run python scripts/download_models.py wordnet-sense-embedding")
        sys.path.insert(0, str(model_path))
        # The published helper assumes POSIX paths when deciding whether it is
        # loading a checkpoint. Build its two modules directly so the same
        # target-token pooling works on Windows and current sentence-transformers.
        from sentence_transformers import SentenceTransformer
        from sentence_transformers.models import Transformer
        from word_pooling import WordPooling

        transformer = Transformer(str(model_path))
        self.model = SentenceTransformer(modules=[transformer, WordPooling(transformer.get_embedding_dimension())])

    @staticmethod
    def context_input(example: dict) -> str:
        return f"'{example['target']}': {example['context']}"

    @staticmethod
    def gloss_input(example: dict, candidate: dict) -> str:
        return f"'{example['lemma']}': {candidate['gloss']}"

    def score(self, example: dict) -> list[float]:
        inputs = [self.context_input(example)] + [self.gloss_input(example, candidate) for candidate in example["candidates"]]
        embeddings = self.model.encode(inputs, normalize_embeddings=True, show_progress_bar=False)
        return (np.asarray(embeddings[1:]) @ np.asarray(embeddings[0])).tolist()


class PosFirstWrapper(Ranker):
    def __init__(self, base: Ranker, name: str) -> None:
        self.base = base
        self.name = name

    def score(self, example: dict) -> list[float]:
        return apply_pos_first(example, self.base.score(example))

    def score_many(self, examples: list[dict]) -> list[list[float]]:
        return [apply_pos_first(example, scores) for example, scores in zip(examples, self.base.score_many(examples))]


def load_ranker(name: str) -> Ranker:
    choices = {
        "mfs": MfsRanker,
        "pos-mfs": PosMfsRanker,
        "pos-order": PosOrderRanker,
        "e5-small": E5SmallRanker,
        "wordnet-sense-embedding": WordNetSenseEmbeddingRanker,
    }
    if name == "pos-e5-small":
        return PosFirstWrapper(E5SmallRanker(), name)
    if name == "pos-wordnet-sense-embedding":
        return PosFirstWrapper(WordNetSenseEmbeddingRanker(), name)
    return choices[name]()
