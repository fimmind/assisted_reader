"""Adapter for SayedShaun's SemCor-trained DistilBERT gloss bi-encoder."""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import numpy as np
import torch
from transformers import AutoConfig, AutoModel, AutoTokenizer

from rankers import (
    EMBEDDING_CACHE_ROOT,
    MODEL_ROOT,
    BenchmarkScores,
    Ranker,
    model_revision,
    target_span,
    unique_inputs,
)


NAME = "sayedshaun-wsd"
MAX_LENGTH = 256
BATCH_SIZE = 64


def marked_context(example: dict) -> str:
    """Insert the two markers used during the checkpoint's training."""
    start, end = target_span(example)
    context = example["context"]
    return f"{context[:start]}<classify>{context[start:end]}</classify>{context[end:]}"


class SayedShaunWsdRanker(Ranker):
    name = NAME
    model_cache_name = NAME

    def __init__(self) -> None:
        model_root = MODEL_ROOT / NAME
        base_root = MODEL_ROOT / "sayedshaun-distilbert-base"
        weight_path = model_root / "cosine" / "step-12000-f1-0.8066.pt"
        if not weight_path.is_file():
            raise FileNotFoundError(f"WSD weights are missing: path={weight_path}")
        if not (base_root / "config.json").is_file():
            raise FileNotFoundError(f"DistilBERT config is missing: path={base_root}")

        self.tokenizer = AutoTokenizer.from_pretrained(str(base_root), local_files_only=True)
        self.tokenizer.add_special_tokens({
            "additional_special_tokens": ["<classify>", "</classify>"],
        })
        config = AutoConfig.from_pretrained(str(base_root), local_files_only=True)
        config.vocab_size = len(self.tokenizer)
        self.model = AutoModel.from_config(config)
        state_dict = torch.load(weight_path, map_location="cpu", weights_only=True)
        weights = {key.removeprefix("encoder."): value for key, value in state_dict.items()}
        if len(weights) != len(state_dict) or any(
            not key.startswith("encoder.") for key in state_dict
        ):
            raise ValueError(f"Unexpected WSD checkpoint keys: path={weight_path}")
        self.model.load_state_dict(weights, strict=True)
        self.model.eval()
        torch.set_num_threads(4)

    def encode(self, texts: list[str]) -> np.ndarray:
        """Use the checkpoint's unnormalized [CLS] vectors and 256-token limit."""
        vectors: list[np.ndarray] = []
        for offset in range(0, len(texts), BATCH_SIZE):
            encoded = self.tokenizer(
                texts[offset:offset + BATCH_SIZE],
                padding=True,
                truncation=True,
                max_length=MAX_LENGTH,
                return_tensors="pt",
            )
            with torch.inference_mode():
                hidden = self.model(**encoded).last_hidden_state[:, 0, :]
            vectors.append(hidden.numpy())
        if not vectors:
            raise ValueError("Cannot encode an empty WSD input list")
        return np.concatenate(vectors)

    def score(self, example: dict) -> list[float]:
        context = self.encode([marked_context(example)])[0]
        glosses = self.encode([candidate["gloss"] for candidate in example["candidates"]])
        return (glosses @ context).tolist()

    def benchmark_score_many(self, examples: list[dict]) -> BenchmarkScores:
        glosses = [
            candidate["gloss"]
            for example in examples
            for candidate in example["candidates"]
        ]
        unique_glosses, inverse = unique_inputs(glosses)
        cache_key = hashlib.sha256(json.dumps({
            "model_revision": model_revision(NAME),
            "base_revision": model_revision("sayedshaun-distilbert-base"),
            "adapter_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "glosses": unique_glosses,
        }, separators=(",", ":"), ensure_ascii=True).encode("utf-8")).hexdigest()
        cache_path = EMBEDDING_CACHE_ROOT / NAME / f"{cache_key}.npy"
        preparation_started = time.perf_counter()
        cache_hit = cache_path.is_file()
        if cache_hit:
            unique_vectors = np.load(cache_path, allow_pickle=False)
        else:
            unique_vectors = self.encode(unique_glosses)
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            temporary_path = cache_path.with_suffix(".tmp.npy")
            np.save(temporary_path, unique_vectors, allow_pickle=False)
            temporary_path.replace(cache_path)
        if unique_vectors.shape != (len(unique_glosses), self.model.config.dim):
            raise ValueError(
                f"Invalid cached gloss vectors: path={cache_path} shape={unique_vectors.shape}"
            )
        preparation_ms = (time.perf_counter() - preparation_started) * 1000

        online_started = time.perf_counter()
        contexts = self.encode([marked_context(example) for example in examples])
        gloss_vectors = unique_vectors[np.asarray(inverse)]
        scores: list[list[float]] = []
        offset = 0
        for example, context in zip(examples, contexts):
            count = len(example["candidates"])
            scores.append((gloss_vectors[offset:offset + count] @ context).tolist())
            offset += count
        online_ms = (time.perf_counter() - online_started) * 1000
        return BenchmarkScores(
            scores=scores,
            preparation_ms=preparation_ms,
            online_ms=online_ms,
            definition_inputs=len(glosses),
            unique_definition_inputs=len(unique_glosses),
            definition_cache_hit=cache_hit,
        )
