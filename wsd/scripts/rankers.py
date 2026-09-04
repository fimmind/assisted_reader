from __future__ import annotations

import sys
import math
import re
from abc import ABC, abstractmethod
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
MODEL_ROOT = ROOT / ".cache" / "models"
TOKEN_RE = re.compile(r"[a-z]+(?:'[a-z]+)?")


class Ranker(ABC):
    name: str

    @abstractmethod
    def score(self, example: dict) -> list[float]:
        raise NotImplementedError

    def score_many(self, examples: list[dict]) -> list[list[float]]:
        return [self.score(example) for example in examples]

    def raw_score_many(self, examples: list[dict]) -> list[list[float]]:
        """Scores before deterministic wrappers such as the POS-first boost."""
        return self.score_many(examples)

    def score_with_raw_many(self, examples: list[dict]) -> tuple[list[list[float]], list[list[float]]]:
        scores = self.score_many(examples)
        return scores, scores


class MfsRanker(Ranker):
    name = "mfs"

    def score(self, example: dict) -> list[float]:
        if any("frequency" in candidate for candidate in example["candidates"]):
            return [float(candidate.get("frequency", 0)) for candidate in example["candidates"]]
        count = len(example["candidates"])
        return [-int(candidate.get("original_rank", index)) / (count + 1) for index, candidate in enumerate(example["candidates"])]


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
        return apply_pos_first(example, MfsRanker().score(example))

    def score_with_raw_many(self, examples: list[dict]) -> tuple[list[list[float]], list[list[float]]]:
        raw = MfsRanker().score_many(examples)
        return [apply_pos_first(example, scores) for example, scores in zip(examples, raw)], raw


class LexicalOverlapRanker(Ranker):
    name = "lexical-overlap"

    def score(self, example: dict) -> list[float]:
        context_tokens = set(TOKEN_RE.findall(example["context"].lower())) - {example["target"].lower(), example["lemma"].lower()}
        documents = [set(TOKEN_RE.findall(candidate["gloss"].lower())) for candidate in example["candidates"]]
        document_frequency = {
            token: sum(token in document for document in documents)
            for token in set().union(*documents)
        }
        count = len(documents)
        return [
            sum(math.log((count + 1) / (document_frequency[token] + 1)) + 1 for token in context_tokens & document)
            / math.sqrt(max(1, len(document)))
            for document in documents
        ]


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


class E5DefinitionOnlyRanker(E5SmallRanker):
    name = "e5-small-definition-only"

    @staticmethod
    def gloss_input(example: dict, candidate: dict) -> str:
        return f"passage: {candidate['gloss']}"


class MiniLMRanker(EmbeddingRanker):
    name = "minilm"

    def __init__(self) -> None:
        from sentence_transformers import SentenceTransformer
        model_path = MODEL_ROOT / "minilm"
        if not model_path.exists():
            raise FileNotFoundError("MiniLM is missing. Run: uv run python scripts/download_models.py minilm")
        self.model = SentenceTransformer(str(model_path), local_files_only=True)

    @staticmethod
    def context_input(example: dict) -> str:
        return f"Target word: {example['target']}. Context: {example['context']}"

    @staticmethod
    def gloss_input(example: dict, candidate: dict) -> str:
        return f"{example['lemma']}. {candidate_pos(candidate) or 'unknown part of speech'}. {candidate['gloss']}"

    def score(self, example: dict) -> list[float]:
        return EmbeddingRanker.score_many(self, [example])[0]


class WslRetrieverRanker(E5SmallRanker):
    name = "wsl-retriever"

    def __init__(self) -> None:
        from sentence_transformers import SentenceTransformer
        model_path = MODEL_ROOT / "wsl-retriever"
        if not model_path.exists():
            raise FileNotFoundError("WSL retriever is missing. Run: uv run python scripts/download_models.py wsl-retriever")
        self.model = SentenceTransformer(str(model_path), local_files_only=True)

    @staticmethod
    def context_input(example: dict) -> str:
        return f"question: {example['context']}"

    @staticmethod
    def gloss_input(example: dict, candidate: dict) -> str:
        return f"passage: {example['lemma']}: {candidate['gloss']}"


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

    def raw_score_many(self, examples: list[dict]) -> list[list[float]]:
        return self.base.score_many(examples)

    def score_with_raw_many(self, examples: list[dict]) -> tuple[list[list[float]], list[list[float]]]:
        raw = self.base.score_many(examples)
        return [apply_pos_first(example, scores) for example, scores in zip(examples, raw)], raw


class ReciprocalRankFusionRanker(Ranker):
    def __init__(self, base: Ranker, name: str, k: int = 60) -> None:
        self.base = base
        self.name = name
        self.k = k

    def raw_score_many(self, examples: list[dict]) -> list[list[float]]:
        semantic_scores = self.base.score_many(examples)
        fused: list[list[float]] = []
        for example, scores in zip(examples, semantic_scores):
            semantic_order = sorted(range(len(scores)), key=lambda index: (-scores[index], index))
            semantic_rank = {index: rank for rank, index in enumerate(semantic_order, start=1)}
            fused.append([
                1 / (self.k + semantic_rank[index])
                + 1 / (self.k + int(candidate.get("original_rank", index)) + 1)
                for index, candidate in enumerate(example["candidates"])
            ])
        return fused

    def score_many(self, examples: list[dict]) -> list[list[float]]:
        return [apply_pos_first(example, scores) for example, scores in zip(examples, self.raw_score_many(examples))]

    def score(self, example: dict) -> list[float]:
        return self.score_many([example])[0]

    def score_with_raw_many(self, examples: list[dict]) -> tuple[list[list[float]], list[list[float]]]:
        raw = self.raw_score_many(examples)
        return [apply_pos_first(example, scores) for example, scores in zip(examples, raw)], raw


def load_ranker(name: str) -> Ranker:
    choices = {
        "mfs": MfsRanker,
        "pos-mfs": PosMfsRanker,
        "pos-order": PosOrderRanker,
        "lexical-overlap": LexicalOverlapRanker,
        "e5-small": E5SmallRanker,
        "e5-small-definition-only": E5DefinitionOnlyRanker,
        "minilm": MiniLMRanker,
        "wsl-retriever": WslRetrieverRanker,
        "wordnet-sense-embedding": WordNetSenseEmbeddingRanker,
    }
    if name == "pos-e5-small":
        return PosFirstWrapper(E5SmallRanker(), name)
    if name == "pos-e5-small-definition-only":
        return PosFirstWrapper(E5DefinitionOnlyRanker(), name)
    if name == "pos-lexical-overlap":
        return PosFirstWrapper(LexicalOverlapRanker(), name)
    if name == "pos-minilm":
        return PosFirstWrapper(MiniLMRanker(), name)
    if name == "pos-wsl-retriever":
        return PosFirstWrapper(WslRetrieverRanker(), name)
    if name == "pos-e5-small-rrf":
        return ReciprocalRankFusionRanker(E5SmallRanker(), name)
    if name == "pos-wsl-retriever-rrf":
        return ReciprocalRankFusionRanker(WslRetrieverRanker(), name)
    if name == "pos-wordnet-sense-embedding":
        return PosFirstWrapper(WordNetSenseEmbeddingRanker(), name)
    return choices[name]()
