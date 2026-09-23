from __future__ import annotations

import csv
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path

from rankers import BenchmarkScores, Ranker, model_revision


PACKAGE_NAMES = ("numpy", "onnxruntime", "sentence-transformers", "torch", "transformers")
RANKER_SOURCE = Path(__file__).with_name("rankers.py")
ETTIN_SOURCE = Path(__file__).with_name("ettin_wsd.py")


def files_digest(paths: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.name.encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
    return digest.hexdigest()


def runtime_versions() -> str:
    versions = {
        package: importlib.metadata.version(package)
        for package in PACKAGE_NAMES
    }
    return json.dumps(versions, sort_keys=True, separators=(",", ":"))


def ranker_implementation_sha256() -> str:
    return files_digest([RANKER_SOURCE, ETTIN_SOURCE])


def native_thread_settings() -> str:
    return json.dumps(
        {
            "OMP_NUM_THREADS": os.environ.get("OMP_NUM_THREADS"),
            "OPENBLAS_NUM_THREADS": os.environ.get("OPENBLAS_NUM_THREADS"),
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def ranker_revision(ranker: Ranker) -> str:
    current = ranker
    while hasattr(current, "base"):
        current = current.base
    cache_name = getattr(current, "model_cache_name", None)
    if not isinstance(cache_name, str):
        return "not-applicable"
    return model_revision(cache_name)


def checkpoint_path(
    result_root: Path,
    benchmark_name: str,
    model_name: str,
) -> Path:
    safe_model = model_name.replace("/", "_")
    return result_root / "checkpoints" / benchmark_name / f"{safe_model}.json"


def write_csv_rows(path: Path, rows: list[dict[str, float | int | str]]) -> None:
    if not rows:
        raise ValueError(f"Cannot write a benchmark CSV without rows: {path}")
    temporary = path.with_suffix(".tmp")
    with temporary.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(
            destination,
            fieldnames=sorted({key for row in rows for key in row}),
        )
        writer.writeheader()
        writer.writerows(rows)
    temporary.replace(path)


def load_score_checkpoint(
    path: Path,
    dataset_sha256: str,
    revision: str,
) -> BenchmarkScores | None:
    if not path.is_file():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    if (
        payload.get("status") != "complete"
        or payload.get("dataset_sha256") != dataset_sha256
        or payload.get("model_revision") != revision
        or payload.get("runtime_versions") != runtime_versions()
        or payload.get("ranker_implementation_sha256") != ranker_implementation_sha256()
        or payload.get("native_thread_settings") != native_thread_settings()
    ):
        return None
    return BenchmarkScores(
        scores=payload["scores"],
        preparation_ms=float(payload["preparation_ms"]),
        online_ms=float(payload["online_ms"]),
        definition_inputs=int(payload["definition_inputs"]),
        unique_definition_inputs=int(payload["unique_definition_inputs"]),
        definition_cache_hit=bool(payload["definition_cache_hit"]),
    )


def save_score_checkpoint(
    path: Path,
    dataset_sha256: str,
    revision: str,
    benchmark: BenchmarkScores,
) -> None:
    payload = {
        "status": "complete",
        "dataset_sha256": dataset_sha256,
        "model_revision": revision,
        "runtime_versions": runtime_versions(),
        "ranker_implementation_sha256": ranker_implementation_sha256(),
        "native_thread_settings": native_thread_settings(),
        "preparation_ms": benchmark.preparation_ms,
        "online_ms": benchmark.online_ms,
        "definition_inputs": benchmark.definition_inputs,
        "unique_definition_inputs": benchmark.unique_definition_inputs,
        "definition_cache_hit": benchmark.definition_cache_hit,
        "scores": benchmark.scores,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    temporary.replace(path)


def load_ranking_checkpoint(
    path: Path,
    dataset_sha256: str,
    revision: str,
) -> tuple[list[list[float]], list[list[float]], float] | None:
    if not path.is_file():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    if (
        payload.get("status") != "complete"
        or payload.get("dataset_sha256") != dataset_sha256
        or payload.get("model_revision") != revision
        or payload.get("runtime_versions") != runtime_versions()
        or payload.get("ranker_implementation_sha256") != ranker_implementation_sha256()
        or payload.get("native_thread_settings") != native_thread_settings()
    ):
        return None
    return payload["scores"], payload["raw_scores"], float(payload["elapsed_ms"])


def save_ranking_checkpoint(
    path: Path,
    dataset_sha256: str,
    revision: str,
    scores: list[list[float]],
    raw_scores: list[list[float]],
    elapsed_ms: float,
) -> None:
    payload = {
        "status": "complete",
        "dataset_sha256": dataset_sha256,
        "model_revision": revision,
        "runtime_versions": runtime_versions(),
        "ranker_implementation_sha256": ranker_implementation_sha256(),
        "native_thread_settings": native_thread_settings(),
        "elapsed_ms": elapsed_ms,
        "scores": scores,
        "raw_scores": raw_scores,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    temporary.replace(path)
