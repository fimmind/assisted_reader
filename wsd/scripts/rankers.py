from __future__ import annotations

import math
import re
import sys
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
MODEL_ROOT = ROOT / ".cache" / "models"
TOKEN_RE = re.compile(r"[a-z]+(?:'[a-z]+)?")


@dataclass(frozen=True)
class BenchmarkScores:
    scores: list[list[float]]
    preparation_ms: float
    online_ms: float


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

    def benchmark_score_many(self, examples: list[dict]) -> BenchmarkScores:
        started = time.perf_counter()
        scores = self.score_many(examples)
        online_ms = (time.perf_counter() - started) * 1000
        return BenchmarkScores(scores=scores, preparation_ms=0.0, online_ms=online_ms)


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


def ascending_ordinal_ranks(values: list[int]) -> dict[int, int]:
    order = sorted(range(len(values)), key=lambda index: (values[index], index))
    return {index: rank for rank, index in enumerate(order, start=1)}


def reciprocal_rank_fusion_scores(
    example: dict,
    semantic_scores: list[float],
    k: int,
    semantic_weight: float,
) -> list[float]:
    semantic_order = sorted(
        range(len(semantic_scores)),
        key=lambda index: (-semantic_scores[index], index),
    )
    semantic_rank = {
        index: rank for rank, index in enumerate(semantic_order, start=1)
    }
    original_ranks = [
        int(candidate.get("original_rank", index))
        for index, candidate in enumerate(example["candidates"])
    ]
    dictionary_rank = ascending_ordinal_ranks(original_ranks)
    return [
        semantic_weight / (k + semantic_rank[index])
        + (1 - semantic_weight) / (k + dictionary_rank[index])
        for index in range(len(example["candidates"]))
    ]


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

    def benchmark_score_many(self, examples: list[dict]) -> BenchmarkScores:
        glosses = [
            self.gloss_input(example, candidate)
            for example in examples
            for candidate in example["candidates"]
        ]
        preparation_started = time.perf_counter()
        gloss_embeddings = np.asarray(self.model.encode(
            glosses,
            batch_size=256,
            normalize_embeddings=True,
            show_progress_bar=False,
        ))
        preparation_ms = (time.perf_counter() - preparation_started) * 1000

        online_started = time.perf_counter()
        contexts = [self.context_input(example) for example in examples]
        context_embeddings = np.asarray(self.model.encode(
            contexts,
            batch_size=256,
            normalize_embeddings=True,
            show_progress_bar=False,
        ))
        scores: list[list[float]] = []
        offset = 0
        for example, context in zip(examples, context_embeddings):
            count = len(example["candidates"])
            scores.append((gloss_embeddings[offset:offset + count] @ context).tolist())
            offset += count
        online_ms = (time.perf_counter() - online_started) * 1000
        return BenchmarkScores(
            scores=scores,
            preparation_ms=preparation_ms,
            online_ms=online_ms,
        )


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


class ArcticEmbedXsRanker(EmbeddingRanker):
    name = "arctic-embed-xs"

    def __init__(self) -> None:
        from sentence_transformers import SentenceTransformer

        model_path = MODEL_ROOT / "arctic-embed-xs"
        if not model_path.exists():
            raise FileNotFoundError(
                "Arctic Embed XS is missing. Run: "
                "python scripts/download_models.py arctic-embed-xs"
            )
        self.model = SentenceTransformer(str(model_path), local_files_only=True)

    @staticmethod
    def context_input(example: dict) -> str:
        return (
            "Represent this sentence for searching relevant passages: "
            f"Target word: {example['target']}. Context: {example['context']}"
        )

    @staticmethod
    def gloss_input(example: dict, candidate: dict) -> str:
        return candidate["gloss"]

    def score(self, example: dict) -> list[float]:
        return EmbeddingRanker.score_many(self, [example])[0]


class CrossEncoderRanker(Ranker):
    def __init__(self, model_name: str, name: str) -> None:
        from sentence_transformers import CrossEncoder

        model_path = MODEL_ROOT / model_name
        if not model_path.exists():
            raise FileNotFoundError(
                f"{name} is missing. Run: python scripts/download_models.py {model_name}"
            )
        self.name = name
        self.model = CrossEncoder(str(model_path), local_files_only=True)

    @staticmethod
    def context_input(example: dict) -> str:
        return f"Target word: {example['target']}. Context: {example['context']}"

    @staticmethod
    def gloss_input(example: dict, candidate: dict) -> str:
        pos = candidate_pos(candidate) or "unknown part of speech"
        return f"{example['lemma']} ({pos}): {candidate['gloss']}"

    def score_many(self, examples: list[dict]) -> list[list[float]]:
        pairs = [
            (self.context_input(example), self.gloss_input(example, candidate))
            for example in examples
            for candidate in example["candidates"]
        ]
        flat_scores = np.asarray(
            self.model.predict(pairs, batch_size=128, show_progress_bar=False)
        ).reshape(-1)
        scores: list[list[float]] = []
        offset = 0
        for example in examples:
            count = len(example["candidates"])
            scores.append(flat_scores[offset:offset + count].tolist())
            offset += count
        return scores

    def score(self, example: dict) -> list[float]:
        return self.score_many([example])[0]


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
        from word_pooling import WordPooling
        from word_pooling import WordSenseTransformer

        # WordSenseTransformer.tokenize creates the word_mask consumed by
        # WordPooling. Current sentence-transformers cannot resolve the
        # checkpoint's training-script module path and silently substitutes
        # ordinary mean pooling, so replace that parameter-free module.
        self.model = WordSenseTransformer(str(model_path), local_files_only=True)
        transformer = self.model._first_module()
        self.model._modules["1"] = WordPooling(
            transformer.get_embedding_dimension()
        )
        if not any(isinstance(module, WordPooling) for module in self.model):
            raise TypeError(f"Word-sense model has no target-word pooling module: {model_path}")

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
    def __init__(self, base: Ranker, name: str, k: int, semantic_weight: float) -> None:
        if semantic_weight < 0 or semantic_weight > 1:
            raise ValueError(f"semantic_weight must be between zero and one, got {semantic_weight}")
        self.base = base
        self.name = name
        self.k = k
        self.semantic_weight = semantic_weight

    def raw_score_many(self, examples: list[dict]) -> list[list[float]]:
        semantic_scores = self.base.score_many(examples)
        return [
            reciprocal_rank_fusion_scores(
                example,
                scores,
                self.k,
                self.semantic_weight,
            )
            for example, scores in zip(examples, semantic_scores)
        ]

    def score_many(self, examples: list[dict]) -> list[list[float]]:
        return [apply_pos_first(example, scores) for example, scores in zip(examples, self.raw_score_many(examples))]

    def score(self, example: dict) -> list[float]:
        return self.score_many([example])[0]

    def score_with_raw_many(self, examples: list[dict]) -> tuple[list[list[float]], list[list[float]]]:
        raw = self.raw_score_many(examples)
        return [apply_pos_first(example, scores) for example, scores in zip(examples, raw)], raw

    def benchmark_score_many(self, examples: list[dict]) -> BenchmarkScores:
        semantic = self.base.benchmark_score_many(examples)
        fused = [
            reciprocal_rank_fusion_scores(
                example,
                scores,
                self.k,
                self.semantic_weight,
            )
            for example, scores in zip(examples, semantic.scores)
        ]
        return BenchmarkScores(
            scores=fused,
            preparation_ms=semantic.preparation_ms,
            online_ms=semantic.online_ms,
        )


def load_ranker(name: str) -> Ranker:
    choices = {
        "arctic-embed-xs": ArcticEmbedXsRanker,
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
    if name == "tinybert-cross-encoder":
        return CrossEncoderRanker(name, name)
    if name == "tinybert-wiktextract-wsd":
        return CrossEncoderRanker(name, name)
    if name == "tinybert-wiktextract-listwise":
        return CrossEncoderRanker(name, name)
    if name == "minilm-l2-cross-encoder":
        return CrossEncoderRanker(name, name)
    if name == "minilm-l6-cross-encoder":
        return CrossEncoderRanker(name, name)
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
        return ReciprocalRankFusionRanker(E5SmallRanker(), name, 60, 0.5)
    if name == "e5-definition-only-rrf":
        return ReciprocalRankFusionRanker(E5DefinitionOnlyRanker(), name, 60, 0.5)
    if name == "arctic-embed-xs-rrf":
        return ReciprocalRankFusionRanker(ArcticEmbedXsRanker(), name, 60, 0.5)
    e5_weight_match = re.fullmatch(r"e5-definition-only-rrf-(25|75)", name)
    if e5_weight_match:
        weight = int(e5_weight_match.group(1)) / 100
        return ReciprocalRankFusionRanker(E5DefinitionOnlyRanker(), name, 60, weight)
    arctic_weight_match = re.fullmatch(r"arctic-embed-xs-rrf-(25|75)", name)
    if arctic_weight_match:
        weight = int(arctic_weight_match.group(1)) / 100
        return ReciprocalRankFusionRanker(ArcticEmbedXsRanker(), name, 60, weight)
    if name == "pos-wsl-retriever-rrf":
        return ReciprocalRankFusionRanker(WslRetrieverRanker(), name, 60, 0.5)
    if name == "pos-wordnet-sense-embedding":
        return PosFirstWrapper(WordNetSenseEmbeddingRanker(), name)
    return choices[name]()
