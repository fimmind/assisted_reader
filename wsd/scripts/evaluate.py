from __future__ import annotations

import argparse
import csv
import json
import time
from pathlib import Path

from metrics import exact_metrics, reader_metrics
from rankers import load_ranker

ROOT = Path(__file__).resolve().parents[1]


def local_cache_size_mb(name: str) -> float:
    name = {
        "pos-e5-small": "e5-small",
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
        "mfs", "pos-mfs", "pos-order", "e5-small", "wordnet-sense-embedding",
        "pos-e5-small", "pos-wordnet-sense-embedding",
    ])
    parser.add_argument("--limit", type=int, default=0, help="Limit examples for a quick smoke test")
    args = parser.parse_args()
    source = ROOT / "data" / "processed" / f"{args.dataset}.jsonl"
    examples = read_jsonl(source)
    if args.limit:
        examples = examples[:args.limit]
    is_reader_data = all(example.get("dataset", "").startswith("reader-") for example in examples)
    results: list[dict] = []
    for name in args.model:
        ranker = load_ranker(name)
        started = time.perf_counter()
        scored = list(zip(examples, ranker.score_many(examples)))
        elapsed_ms = (time.perf_counter() - started) * 1000
        metrics = reader_metrics(scored) if is_reader_data else exact_metrics(scored)
        record = {
            "model": name,
            "dataset": args.dataset,
            "local_cache_mb": local_cache_size_mb(name),
            "examples_per_second": len(examples) / (elapsed_ms / 1000) if elapsed_ms else 0,
            **metrics,
        }
        results.append(record)
        print(json.dumps(record, indent=2))
    output_dir = ROOT / "results"
    output_dir.mkdir(exist_ok=True)
    output = output_dir / f"{args.dataset}-benchmark.csv"
    with output.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(destination, fieldnames=sorted({key for result in results for key in result}))
        writer.writeheader()
        writer.writerows(results)
    print(f"wrote {output}")


if __name__ == "__main__":
    main()
