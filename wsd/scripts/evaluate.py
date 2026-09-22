from __future__ import annotations

import argparse
import csv
import json
import time
from pathlib import Path

from benchmarking import (
    checkpoint_path,
    files_digest,
    load_ranking_checkpoint,
    native_thread_settings,
    ranker_implementation_sha256,
    ranker_revision,
    runtime_versions,
    save_ranking_checkpoint,
)
from metrics import exact_metrics, is_same_pos_hard_example, reader_metrics
from rankers import load_ranker

ROOT = Path(__file__).resolve().parents[1]


def local_cache_size_mb(name: str) -> float:
    name = {
        "pos-arctic-embed-xs": "arctic-embed-xs",
        "pos-e5-small": "e5-small",
        "pos-e5-small-rrf": "e5-small",
        "e5-small-definition-only": "e5-small",
        "pos-e5-small-definition-only": "e5-small",
        "pos-minilm": "minilm",
        "pos-wsl-retriever": "wsl-retriever",
        "pos-wsl-retriever-rrf": "wsl-retriever",
        "pos-wordnet-sense-embedding": "wordnet-sense-embedding",
    }.get(name, name)
    directory = ROOT / ".cache" / "models" / name
    if not directory.exists():
        return 0.0
    return sum(
        path.stat().st_size
        for path in directory.rglob("*")
        if path.is_file() and ".cache" not in path.relative_to(directory).parts
    ) / 1_000_000


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True, help="Processed basename, for example raganato-all or reader-dev-v1")
    parser.add_argument("--model", nargs="+", required=True, choices=[
        "mfs", "pos-mfs", "pos-order", "lexical-overlap", "pos-lexical-overlap",
        "arctic-embed-xs", "tinybert-cross-encoder", "tinybert-wiktextract-wsd", "tinybert-wiktextract-listwise", "minilm-l2-cross-encoder", "minilm-l6-cross-encoder",
        "e5-small", "pos-e5-small", "e5-small-definition-only", "pos-e5-small-definition-only", "minilm", "pos-minilm",
        "wordnet-sense-embedding", "pos-wordnet-sense-embedding",
        "wsl-retriever", "pos-wsl-retriever", "pos-e5-small-rrf", "pos-wsl-retriever-rrf",
    ])
    parser.add_argument("--limit", type=int, default=0, help="Limit examples for a quick smoke test")
    parser.add_argument("--append", action="store_true", help="Merge these model rows into an existing result CSV")
    args = parser.parse_args()
    source = ROOT / "data" / "processed" / f"{args.dataset}.jsonl"
    dataset_sha256 = files_digest([source])
    examples = read_jsonl(source)
    dataset_label = args.dataset
    if args.limit:
        examples = examples[:args.limit]
        dataset_label = f"{args.dataset}/smoke-{args.limit}"
    is_reader_data = all(example.get("dataset", "").startswith("reader-") for example in examples)
    results: list[dict] = []
    for name in args.model:
        ranker = load_ranker(name)
        revision = ranker_revision(ranker)
        checkpoint = checkpoint_path(
            ROOT / "results",
            f"ranking-{dataset_sha256[:12]}-limit-{args.limit}",
            name,
        )
        cached = load_ranking_checkpoint(checkpoint, dataset_sha256, revision)
        score_source = "checkpoint"
        if cached is None:
            started = time.perf_counter()
            final_scores, raw_scores = ranker.score_with_raw_many(examples)
            elapsed_ms = (time.perf_counter() - started) * 1000
            save_ranking_checkpoint(
                checkpoint,
                dataset_sha256,
                revision,
                final_scores,
                raw_scores,
                elapsed_ms,
            )
            score_source = "computed"
        else:
            final_scores, raw_scores, elapsed_ms = cached
        scored = list(zip(examples, final_scores, raw_scores))
        common = {
            "model": name,
            "local_cache_mb": local_cache_size_mb(name),
            "examples_per_second": len(examples) / (elapsed_ms / 1000) if elapsed_ms else 0,
            "status": "complete",
            "dataset_sha256": dataset_sha256,
            "model_revision": revision,
            "runtime_versions": runtime_versions(),
            "ranker_implementation_sha256": ranker_implementation_sha256(),
            "native_thread_settings": native_thread_settings(),
            "score_source": score_source,
            "sample_limit": args.limit,
        }
        if is_reader_data:
            slices = {
                "full": scored,
                "same-pos": [item for item in scored if is_same_pos_hard_example(item[0])],
            }
            for slice_name, slice_examples in slices.items():
                record = {
                    **common,
                    "dataset": f"{dataset_label}/{slice_name}",
                    "slice": slice_name,
                    **reader_metrics(slice_examples),
                }
                results.append(record)
                print(json.dumps(record, indent=2))
        else:
            record = {**common, "dataset": dataset_label, **exact_metrics((example, scores) for example, scores, _ in scored)}
            results.append(record)
            print(json.dumps(record, indent=2))
    output_dir = ROOT / "results"
    output_dir.mkdir(exist_ok=True)
    output_suffix = f"smoke-{args.limit}" if args.limit else "benchmark"
    output = output_dir / f"{args.dataset}-{output_suffix}.csv"
    if args.append and output.exists():
        with output.open(newline="", encoding="utf-8") as existing_file:
            existing = list(csv.DictReader(existing_file))
        replaced = {(result["model"], result["dataset"]) for result in results}
        results = [row for row in existing if (row.get("model"), row.get("dataset")) not in replaced] + results
    with output.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(destination, fieldnames=sorted({key for result in results for key in result}))
        writer.writeheader()
        writer.writerows(results)
    print(f"wrote {output}")


if __name__ == "__main__":
    main()
