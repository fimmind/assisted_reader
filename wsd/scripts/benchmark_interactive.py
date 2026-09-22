from __future__ import annotations

import argparse
import json
import os
import resource
import time
from math import ceil
from pathlib import Path
from typing import Callable

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")

import numpy as np

from benchmarking import (
    files_digest,
    native_thread_settings,
    ranker_implementation_sha256,
    ranker_revision,
    runtime_versions,
)
from rankers import EmbeddingRanker, Ranker, load_ranker


ROOT = Path(__file__).resolve().parents[1]


def read_jsonl(path: Path) -> list[dict]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def percentile(values: list[float], probability: float) -> float:
    if not values:
        raise ValueError("Cannot calculate a percentile without measurements")
    index = max(0, ceil(probability * len(values)) - 1)
    return sorted(values)[index]


def peak_rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def prepare_scorer(
    ranker: Ranker,
    example: dict,
) -> tuple[Callable[[], list[float]], float, int, bool]:
    if isinstance(ranker, EmbeddingRanker):
        glosses = [
            ranker.gloss_input(example, candidate)
            for candidate in example["candidates"]
        ]
        gloss_embeddings, preparation_ms, unique_count, cache_hit = (
            ranker.cached_gloss_embeddings(glosses)
        )
        context_input = ranker.context_input(example)

        def score() -> list[float]:
            context = np.asarray(ranker.model.encode(
                [context_input],
                batch_size=1,
                normalize_embeddings=True,
                show_progress_bar=False,
            ))[0]
            return (gloss_embeddings @ context).tolist()

        return score, preparation_ms, unique_count, cache_hit

    return lambda: ranker.score(example), 0.0, len(example["candidates"]), False


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--example-index", type=int, required=True)
    parser.add_argument("--warmups", type=int, required=True)
    parser.add_argument("--repetitions", type=int, required=True)
    args = parser.parse_args()
    if args.example_index < 0 or args.warmups < 1 or args.repetitions < 2:
        raise ValueError(
            "example-index must be non-negative, warmups must be positive, "
            "and repetitions must be at least two"
        )

    source = ROOT / "data" / "processed" / f"{args.dataset}.jsonl"
    examples = read_jsonl(source)
    if args.example_index >= len(examples):
        raise IndexError(
            f"example-index is outside dataset: index={args.example_index} examples={len(examples)}"
        )
    example = examples[args.example_index]

    startup_started = time.perf_counter()
    ranker = load_ranker(args.model)
    startup_ms = (time.perf_counter() - startup_started) * 1000
    score, preparation_ms, unique_definitions, cache_hit = prepare_scorer(ranker, example)
    for _ in range(args.warmups):
        scores = score()
        if len(scores) != len(example["candidates"]):
            raise ValueError(
                f"Ranker returned wrong score count: model={args.model} "
                f"scores={len(scores)} candidates={len(example['candidates'])}"
            )

    latencies_ms: list[float] = []
    for _ in range(args.repetitions):
        started = time.perf_counter()
        score()
        latencies_ms.append((time.perf_counter() - started) * 1000)

    result = {
        "status": "complete",
        "dataset": args.dataset,
        "dataset_sha256": files_digest([source]),
        "example_id": example.get("id"),
        "example_index": args.example_index,
        "model": args.model,
        "model_revision": ranker_revision(ranker),
        "runtime_versions": json.loads(runtime_versions()),
        "ranker_implementation_sha256": ranker_implementation_sha256(),
        "native_thread_settings": json.loads(native_thread_settings()),
        "candidate_definitions": len(example["candidates"]),
        "unique_definition_inputs": unique_definitions,
        "definition_cache_hit": cache_hit,
        "offline_preparation_ms": preparation_ms,
        "startup_ms": startup_ms,
        "warmups": args.warmups,
        "repetitions": args.repetitions,
        "latency_p50_ms": percentile(latencies_ms, 0.50),
        "latency_p95_ms": percentile(latencies_ms, 0.95),
        "latency_min_ms": min(latencies_ms),
        "latency_max_ms": max(latencies_ms),
        "peak_rss_mb": peak_rss_mb(),
    }
    output_dir = ROOT / "results" / "interactive"
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / f"{args.dataset}-{args.model}.json"
    temporary = output.with_suffix(".tmp")
    temporary.write_text(json.dumps(result, indent=2), encoding="utf-8")
    temporary.replace(output)
    print(json.dumps({**result, "output": str(output)}, indent=2))


if __name__ == "__main__":
    main()
