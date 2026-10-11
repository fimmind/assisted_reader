"""Package the SayedShaun encoder and precomputed site WordNet vectors."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import time

import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

from wsd_progress import report_progress
from wsd_memory import require_memory_scope


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "wsd" / ".cache" / "exports" / "sayedshaun-wsd"
MODEL = SOURCE / "model-int8.onnx"
DESTINATION = ROOT / "public" / "wsd" / "sayedshaun-wsd"
WORDNET = ROOT / "data" / "wordnet"
PART_SIZE = 50_000_000
REVISION = "54e41c09c61ae8bd60c62e40bf483141c49ce0d3"
VECTOR_SIZE = 768
VECTOR_WORK = ROOT / "wsd" / ".cache" / "sayedshaun-vectors-float16.bin"
VECTOR_PROGRESS = ROOT / "wsd" / ".cache" / "sayedshaun-vectors-progress.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def package_vectors() -> dict[str, object]:
    bucket_entries: dict[str, dict[str, list[str]]] = {}
    texts: list[str] = []
    source_digest = hashlib.sha256()
    for source in sorted(WORDNET.glob("[0-9][0-9][0-9][0-9].json")):
        raw = source.read_bytes()
        source_digest.update(source.name.encode("ascii"))
        source_digest.update(raw)
        entries: dict[str, list[str]] = {}
        for entry in json.loads(raw):
            definitions = [definition for sense in entry["senses"] for definition in sense["definitions"]]
            if len(definitions) < 2:
                continue
            entries[entry["word"]] = [definition["id"] for definition in definitions]
            texts.extend(definition["gloss"] for definition in definitions)
        bucket_entries[source.stem] = entries
    print(json.dumps({"stage": "glosses", "count": len(texts)}), flush=True)
    tokenizer = AutoTokenizer.from_pretrained(str(SOURCE), local_files_only=True)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    session = ort.InferenceSession(str(MODEL), sess_options=options, providers=["CPUExecutionProvider"])
    model_hash = sha256(MODEL)
    source_hash = source_digest.hexdigest()
    completed = 0
    if VECTOR_PROGRESS.is_file():
        progress = json.loads(VECTOR_PROGRESS.read_text(encoding="utf-8"))
        if (progress.get("count") == len(texts) and progress.get("model_sha256") == model_hash
                and progress.get("source_sha256") == source_hash
                and VECTOR_WORK.is_file() and VECTOR_WORK.stat().st_size == len(texts) * VECTOR_SIZE * 2):
            completed = int(progress["completed"])
    if not 0 <= completed <= len(texts):
        raise ValueError(f"Invalid SayedShaun vector progress: completed={completed} total={len(texts)}")
    vectors = np.memmap(VECTOR_WORK, dtype="<f2", mode="r+" if completed else "w+",
                        shape=(len(texts), VECTOR_SIZE))
    lengths: list[int] = []
    tokenizing_started = time.monotonic()
    for first in range(0, len(texts), 256):
        lengths.extend(len(ids) for ids in tokenizer(texts[first:first + 256], add_special_tokens=True,
                                                     truncation=True, max_length=256)["input_ids"])
        if first % 3200 == 0 or first + 256 >= len(texts):
            report_progress("SayedShaun tokenization", min(first + 256, len(texts)), len(texts), tokenizing_started, 0)
    order = np.argsort(np.asarray(lengths), kind="stable")
    encoding_started = time.monotonic()
    report_progress("SayedShaun embeddings", completed, len(order), encoding_started, completed)
    for offset in range(completed, len(order), 64):
        indices = order[offset:offset + 64]
        encoded = tokenizer([texts[index] for index in indices], padding=True, truncation=True,
                            max_length=256, return_tensors="np")
        hidden = session.run(None, {"input_ids": encoded["input_ids"].astype(np.int64),
                                    "attention_mask": encoded["attention_mask"].astype(np.int64)})[0]
        if hidden.shape != (len(indices), VECTOR_SIZE) or not np.isfinite(hidden).all():
            raise ValueError(f"Invalid SayedShaun gloss output: offset={offset} shape={hidden.shape}")
        vectors[indices] = hidden.astype(np.float16)
        if (offset + len(indices)) // 3200 > offset // 3200 or offset + len(indices) == len(order):
            vectors.flush()
            progress_path = VECTOR_PROGRESS.with_suffix(".tmp")
            progress_path.write_text(json.dumps({"count": len(texts), "model_sha256": model_hash,
                                                 "source_sha256": source_hash,
                                                 "completed": offset + len(indices)}) + "\n", encoding="utf-8")
            progress_path.replace(VECTOR_PROGRESS)
            report_progress("SayedShaun embeddings", offset + len(indices), len(texts), encoding_started, completed)
    vector_root = DESTINATION / "vectors"
    vector_root.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, dict[str, int | str]] = {}
    global_offset = 0
    for bucket, entries in sorted(bucket_entries.items()):
        index: dict[str, tuple[int, list[str]]] = {}
        offset = 0
        for word, ids in entries.items():
            index[word] = (offset, ids)
            offset += len(ids)
        metadata_path = vector_root / f"{bucket}.json"
        vectors_path = vector_root / f"{bucket}.bin"
        metadata_path.write_text(json.dumps(index, separators=(",", ":")) + "\n", encoding="utf-8")
        vectors[global_offset:global_offset + offset].tofile(vectors_path)
        manifest[bucket] = {"count": offset, "metadataSha256": sha256(metadata_path),
                            "vectorsSha256": sha256(vectors_path), "bytes": vectors_path.stat().st_size}
        global_offset += offset
    if global_offset != len(texts):
        raise ValueError(f"SayedShaun vector count mismatch: offset={global_offset} texts={len(texts)}")
    return {"format": "float16-le", "dimensions": VECTOR_SIZE, "count": len(texts),
            "sourceSha256": source_hash, "modelSha256": model_hash, "buckets": manifest}


def main() -> None:
    require_memory_scope()
    if not MODEL.is_file():
        raise FileNotFoundError(f"Missing exported SayedShaun model: path={MODEL}")
    DESTINATION.mkdir(parents=True, exist_ok=True)
    parts: list[dict[str, int | str]] = []
    with MODEL.open("rb") as source:
        index = 0
        while chunk := source.read(PART_SIZE):
            name = f"model.part{index:02d}"
            destination = DESTINATION / name
            destination.write_bytes(chunk)
            parts.append({"name": name, "size": len(chunk), "sha256": sha256(destination)})
            index += 1
    if not parts:
        raise ValueError(f"SayedShaun model is empty: path={MODEL}")
    metadata: dict[str, str] = {}
    for name in ("tokenizer.json", "tokenizer_config.json"):
        shutil.copyfile(SOURCE / name, DESTINATION / name)
        metadata[name] = sha256(DESTINATION / name)
    manifest = {
        "model": "SayedShaun/word-sense-disambiguation",
        "revision": REVISION,
        "license": "MIT",
        "quantization": "dynamic-uint8",
        "size": MODEL.stat().st_size,
        "parts": parts,
        "metadata": metadata,
    }
    manifest["vectors"] = package_vectors()
    manifest_path = DESTINATION / "manifest.json"
    temporary = manifest_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    temporary.replace(manifest_path)
    VECTOR_WORK.unlink()
    VECTOR_PROGRESS.unlink()
    print(json.dumps({"stage": "done", "destination": str(DESTINATION)}), flush=True)


if __name__ == "__main__":
    main()
