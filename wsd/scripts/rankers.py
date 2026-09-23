from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

# Termux's OpenBLAS build can corrupt its buffer bookkeeping when PyTorch and
# NumPy initialize competing native thread pools. Keep both native pools
# single-threaded so performance runs are stable and shutdown is memory-safe.
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
MODEL_ROOT = ROOT / ".cache" / "models"
EMBEDDING_CACHE_ROOT = ROOT / ".cache" / "definition-embeddings"
TOKEN_RE = re.compile(r"[a-z]+(?:'[a-z]+)?")
TARGET_OPEN = "[TGT]"
TARGET_CLOSE = "[/TGT]"


@dataclass(frozen=True)
class BenchmarkScores:
    scores: list[list[float]]
    preparation_ms: float
    online_ms: float
    definition_inputs: int
    unique_definition_inputs: int
    definition_cache_hit: bool


def target_span(example: dict) -> tuple[int, int]:
    context = example["context"]
    target = example["target"]
    start = example.get("target_start")
    if start is None:
        matches = [match.start() for match in re.finditer(re.escape(target), context, re.IGNORECASE)]
        if len(matches) != 1:
            raise ValueError(
                f"Example requires target_start because the target occurrence is ambiguous: "
                f"id={example.get('id')} target={target!r} matches={matches}"
            )
        start = matches[0]
    if type(start) is not int:
        raise TypeError(f"target_start must be an integer: id={example.get('id')} value={start!r}")
    end = start + len(target)
    if start < 0 or context[start:end] != target:
        raise ValueError(
            f"Target span does not match context: id={example.get('id')} "
            f"target={target!r} start={start} actual={context[start:end]!r}"
        )
    return start, end


def marked_context(example: dict) -> str:
    start, end = target_span(example)
    context = example["context"]
    return f"{context[:start]}{TARGET_OPEN}{context[start:end]}{TARGET_CLOSE}{context[end:]}"


def model_revision(model_name: str) -> str:
    model_root = MODEL_ROOT / model_name
    metadata_files = sorted(
        (model_root / ".cache" / "huggingface" / "download").rglob("*.metadata")
    )
    revisions = {
        line
        for path in metadata_files
        if (line := path.read_text(encoding="utf-8").splitlines()[0].strip())
    }
    if len(revisions) > 1:
        raise ValueError(f"Model cache contains mixed revisions: model={model_name} revisions={sorted(revisions)}")
    if revisions:
        return next(iter(revisions))
    if not model_root.is_dir():
        raise FileNotFoundError(f"Model directory is missing: {model_root}")
    digest = hashlib.sha256()
    model_files = sorted(
        path
        for path in model_root.rglob("*")
        if path.is_file() and ".cache" not in path.relative_to(model_root).parts
    )
    if not model_files:
        raise FileNotFoundError(f"Model directory contains no files: {model_root}")
    for path in model_files:
        digest.update(str(path.relative_to(model_root)).encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
    return f"local-{digest.hexdigest()}"


def unique_inputs(values: list[str]) -> tuple[list[str], list[int]]:
    unique: list[str] = []
    indices: dict[str, int] = {}
    inverse: list[int] = []
    for value in values:
        index = indices.get(value)
        if index is None:
            index = len(unique)
            indices[value] = index
            unique.append(value)
        inverse.append(index)
    return unique, inverse


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
        definition_inputs = sum(len(example["candidates"]) for example in examples)
        return BenchmarkScores(
            scores=scores,
            preparation_ms=0.0,
            online_ms=online_ms,
            definition_inputs=definition_inputs,
            unique_definition_inputs=definition_inputs,
            definition_cache_hit=False,
        )


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
    model_cache_name: str

    def cached_gloss_embeddings(
        self,
        glosses: list[str],
    ) -> tuple[np.ndarray, float, int, bool]:
        unique_glosses, inverse = unique_inputs(glosses)
        revision = model_revision(self.model_cache_name)
        cache_key = hashlib.sha256(
            json.dumps(
                {
                    "ranker": self.name,
                    "revision": revision,
                    "implementation": hashlib.sha256(
                        Path(__file__).read_bytes()
                    ).hexdigest(),
                    "inputs": unique_glosses,
                },
                ensure_ascii=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        cache_dir = EMBEDDING_CACHE_ROOT / self.name
        cache_path = cache_dir / f"{cache_key}.npy"
        preparation_started = time.perf_counter()
        if cache_path.is_file():
            unique_embeddings = np.load(cache_path, allow_pickle=False)
            cache_hit = True
        else:
            unique_embeddings = np.asarray(self.model.encode(
                unique_glosses,
                batch_size=256,
                normalize_embeddings=True,
                show_progress_bar=True,
            ))
            cache_dir.mkdir(parents=True, exist_ok=True)
            temporary_path = cache_path.with_suffix(".tmp.npy")
            np.save(temporary_path, unique_embeddings, allow_pickle=False)
            temporary_path.replace(cache_path)
            cache_hit = False
        if unique_embeddings.ndim != 2 or len(unique_embeddings) != len(unique_glosses):
            raise ValueError(
                f"Invalid cached definition embeddings: path={cache_path} "
                f"shape={unique_embeddings.shape} expected_rows={len(unique_glosses)}"
            )
        preparation_ms = (time.perf_counter() - preparation_started) * 1000
        return unique_embeddings[np.asarray(inverse)], preparation_ms, len(unique_glosses), cache_hit

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
        gloss_embeddings, preparation_ms, unique_count, cache_hit = (
            self.cached_gloss_embeddings(glosses)
        )

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
            definition_inputs=len(glosses),
            unique_definition_inputs=unique_count,
            definition_cache_hit=cache_hit,
        )


class E5SmallRanker(EmbeddingRanker):
    name = "e5-small"
    model_cache_name = "e5-small"

    def __init__(self) -> None:
        from sentence_transformers import SentenceTransformer

        model_path = MODEL_ROOT / "e5-small"
        if not model_path.exists():
            raise FileNotFoundError("E5-small is missing. Run: uv run python scripts/download_models.py e5-small")
        self.model = SentenceTransformer(str(model_path), local_files_only=True)

    @staticmethod
    def context_input(example: dict) -> str:
        return f"query: Target occurrence: {marked_context(example)}"

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
    model_cache_name = "minilm"

    def __init__(self) -> None:
        from sentence_transformers import SentenceTransformer
        model_path = MODEL_ROOT / "minilm"
        if not model_path.exists():
            raise FileNotFoundError("MiniLM is missing. Run: uv run python scripts/download_models.py minilm")
        self.model = SentenceTransformer(str(model_path), local_files_only=True)

    @staticmethod
    def context_input(example: dict) -> str:
        return f"Target occurrence: {marked_context(example)}"

    @staticmethod
    def gloss_input(example: dict, candidate: dict) -> str:
        return f"{example['lemma']}. {candidate_pos(candidate) or 'unknown part of speech'}. {candidate['gloss']}"

    def score(self, example: dict) -> list[float]:
        return EmbeddingRanker.score_many(self, [example])[0]


class ArcticEmbedXsRanker(EmbeddingRanker):
    name = "arctic-embed-xs"
    model_cache_name = "arctic-embed-xs"

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
            f"Target occurrence: {marked_context(example)}"
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
        self.model_cache_name = model_name
        self.model = CrossEncoder(str(model_path), local_files_only=True)

    @staticmethod
    def context_input(example: dict) -> str:
        return f"Target occurrence: {marked_context(example)}"

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


class OnnxNliRanker(Ranker):
    """Score each context and definition as an NLI premise and hypothesis."""

    def __init__(self, name: str, model_cache_name: str, weight_file: str) -> None:
        import onnxruntime as ort
        from transformers import AutoTokenizer

        model_path = MODEL_ROOT / model_cache_name
        weights = model_path / "onnx" / weight_file
        if not weights.is_file():
            raise FileNotFoundError(f"NLI checkpoint is missing: model={name} path={weights}")
        config = json.loads((model_path / "config.json").read_text(encoding="utf-8"))
        labels = {label.lower(): int(index) for index, label in config["id2label"].items()}
        if set(labels) != {"entailment", "neutral", "contradiction"}:
            raise ValueError(f"Unexpected NLI labels: model={name} labels={labels}")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(weights), options, providers=["CPUExecutionProvider"])
        self.input_names = {item.name for item in self.session.get_inputs()}
        self.tokenizer = AutoTokenizer.from_pretrained(str(model_path), local_files_only=True)
        self.entailment_index = labels["entailment"]
        self.contradiction_index = labels["contradiction"]
        self.name = name
        self.model_cache_name = model_cache_name

    @staticmethod
    def hypothesis(example: dict, candidate: dict) -> str:
        gloss = candidate["gloss"].strip().rstrip(". ")
        return f"Here, '{example['target']}' means {gloss}."

    def probabilities_many(self, examples: list[dict]) -> np.ndarray:
        pairs: list[tuple[str, str]] = [
            (example["context"], self.hypothesis(example, candidate))
            for example in examples
            for candidate in example["candidates"]
        ]
        probability_batches: list[np.ndarray] = []
        for start in range(0, len(pairs), 16):
            batch = pairs[start:start + 16]
            encoded = self.tokenizer(
                [premise for premise, _ in batch],
                [hypothesis for _, hypothesis in batch],
                padding=True,
                truncation="only_first",
                max_length=384,
                return_tensors="np",
            )
            inputs = {key: value for key, value in encoded.items() if key in self.input_names}
            logits = np.asarray(self.session.run(["logits"], inputs)[0], dtype=np.float64)
            if logits.shape != (len(batch), 3):
                raise ValueError(f"Unexpected NLI output: model={self.name} shape={logits.shape}")
            shifted = logits - logits.max(axis=1, keepdims=True)
            probabilities = np.exp(shifted) / np.exp(shifted).sum(axis=1, keepdims=True)
            probability_batches.append(probabilities)
        return np.concatenate(probability_batches, axis=0) if probability_batches else np.empty((0, 3))

    @staticmethod
    def group_scores(examples: list[dict], flat_scores: list[float]) -> list[list[float]]:
        scores: list[list[float]] = []
        offset = 0
        for example in examples:
            count = len(example["candidates"])
            scores.append(flat_scores[offset:offset + count])
            offset += count
        if offset != len(flat_scores):
            raise ValueError(f"NLI score count mismatch: expected={offset} actual={len(flat_scores)}")
        return scores

    def score_many(self, examples: list[dict]) -> list[list[float]]:
        probabilities = self.probabilities_many(examples)
        return self.group_scores(examples, probabilities[:, self.entailment_index].tolist())

    def score(self, example: dict) -> list[float]:
        return self.score_many([example])[0]


class OnnxNliNonContradictionRanker(OnnxNliRanker):
    """Rank definitions by their probability of being non-contradictory."""

    def score_many(self, examples: list[dict]) -> list[list[float]]:
        probabilities = self.probabilities_many(examples)
        flat_scores = (1.0 - probabilities[:, self.contradiction_index]).tolist()
        return self.group_scores(examples, flat_scores)


class WslRetrieverRanker(E5SmallRanker):
    name = "wsl-retriever"
    model_cache_name = "wsl-retriever"

    def __init__(self) -> None:
        from sentence_transformers import SentenceTransformer
        model_path = MODEL_ROOT / "wsl-retriever"
        if not model_path.exists():
            raise FileNotFoundError("WSL retriever is missing. Run: uv run python scripts/download_models.py wsl-retriever")
        self.model = SentenceTransformer(str(model_path), local_files_only=True)

    @staticmethod
    def context_input(example: dict) -> str:
        return f"question: {marked_context(example)}"

    @staticmethod
    def gloss_input(example: dict, candidate: dict) -> str:
        return f"passage: {example['lemma']}: {candidate['gloss']}"


class WordNetSenseEmbeddingRanker(EmbeddingRanker):
    name = "wordnet-sense-embedding"
    model_cache_name = "wordnet-sense-embedding"

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
        # sentence-transformers >=5 calls preprocess() from encode(), while the
        # published helper only overrides tokenize(). Bind its target-mask
        # implementation to the actual encoding path.
        self.model.preprocess = self.model.tokenize
        if not any(isinstance(module, WordPooling) for module in self.model):
            raise TypeError(f"Word-sense model has no target-word pooling module: {model_path}")
        probe = self.model.preprocess(["'bank': [TGT]bank[/TGT] context"])
        if "word_mask" not in probe:
            raise TypeError(f"Word-sense model preprocessing omitted word_mask: {model_path}")

    @staticmethod
    def context_input(example: dict) -> str:
        return f"'{example['target']}': {marked_context(example)}"

    @staticmethod
    def gloss_input(example: dict, candidate: dict) -> str:
        return f"'{example['lemma']}': {candidate['gloss']}"

    def score(self, example: dict) -> list[float]:
        inputs = [self.context_input(example)] + [self.gloss_input(example, candidate) for candidate in example["candidates"]]
        embeddings = self.model.encode(inputs, normalize_embeddings=True, show_progress_bar=False)
        return (np.asarray(embeddings[1:]) @ np.asarray(embeddings[0])).tolist()


class Int8WordNetSenseEmbeddingRanker(WordNetSenseEmbeddingRanker):
    name = "wordnet-sense-embedding-int8"

    def __init__(self) -> None:
        import torch
        from torch import nn

        super().__init__()
        self.model = torch.ao.quantization.quantize_dynamic(
            self.model,
            {nn.Linear},
            dtype=torch.qint8,
        )
        quantized_layers = sum(
            isinstance(module, torch.ao.nn.quantized.dynamic.Linear)
            for module in self.model.modules()
        )
        if quantized_layers == 0:
            raise RuntimeError("WordNet sense model has no INT8 dynamic linear layers")


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

    def benchmark_score_many(self, examples: list[dict]) -> BenchmarkScores:
        base = self.base.benchmark_score_many(examples)
        return BenchmarkScores(
            scores=[
                apply_pos_first(example, scores)
                for example, scores in zip(examples, base.scores)
            ],
            preparation_ms=base.preparation_ms,
            online_ms=base.online_ms,
            definition_inputs=base.definition_inputs,
            unique_definition_inputs=base.unique_definition_inputs,
            definition_cache_hit=base.definition_cache_hit,
        )


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
            definition_inputs=semantic.definition_inputs,
            unique_definition_inputs=semantic.unique_definition_inputs,
            definition_cache_hit=semantic.definition_cache_hit,
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
        "wordnet-sense-embedding-int8": Int8WordNetSenseEmbeddingRanker,
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
    if name == "nli-minilm2-int8":
        return OnnxNliRanker(name, name, "model_quint8_avx2.onnx")
    if name == "nli-minilm2-int8-noncontradiction":
        return OnnxNliNonContradictionRanker(name, "nli-minilm2-int8", "model_quint8_avx2.onnx")
    if name == "distilbert-mnli-int8":
        return OnnxNliRanker(name, name, "model_int8.onnx")
    if name == "distilbert-mnli-int8-noncontradiction":
        return OnnxNliNonContradictionRanker(name, "distilbert-mnli-int8", "model_int8.onnx")
    if name == "mobilebert-mnli-q4f16":
        return OnnxNliRanker(name, name, "model_q4f16.onnx")
    if name == "mobilebert-mnli-q4f16-noncontradiction":
        return OnnxNliNonContradictionRanker(name, "mobilebert-mnli-q4f16", "model_q4f16.onnx")
    if name in {"ettin-150m-wsd", "modernbert-large-wsd"}:
        from ettin_wsd import EttinWsdRanker

        return EttinWsdRanker(name)
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
