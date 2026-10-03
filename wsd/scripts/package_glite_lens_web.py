"""Package the Glite LENS context tower and precomputed site WordNet vectors."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import time

import nltk
from nltk.corpus import wordnet as wn
import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

from wsd_progress import report_progress
from wsd_memory import require_memory_scope


ROOT = Path(__file__).resolve().parents[2]
WSD_ROOT = ROOT / "wsd"
SOURCE = WSD_ROOT / ".cache" / "exports" / "glite-lens"
MODEL = SOURCE / "model-int8.onnx"
BASE = WSD_ROOT / ".cache" / "models" / "glite-lens-base"
DESTINATION = ROOT / "public" / "wsd" / "glite-lens"
WORDNET = ROOT / "data" / "wordnet"
PART_SIZE = 50_000_000
REVISION = "glite-lens-seed42-context-int8-v1"
VECTOR_SIZE = 768
GLOSS_MODEL = SOURCE / "gloss-int8.onnx"
VECTOR_WORK = WSD_ROOT / ".cache" / "glite-lens-vectors-float16.bin"
VECTOR_PROGRESS = WSD_ROOT / ".cache" / "glite-lens-vectors-progress.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def structured_gloss(word: str, part_of_speech: str, definition: dict[str, str]) -> str:
    synset = wn.synset(definition["id"])
    if synset.definition() != definition["gloss"]:
        raise ValueError(f"WordNet gloss mismatch: word={word} id={definition['id']}")
    normalized_headword = word.replace("_", " ").strip().lower()
    synonyms: list[str] = []
    seen: set[str] = set()
    for lemma in synset.lemmas():
        synonym = lemma.name().replace("_", " ").strip()
        normalized = synonym.lower()
        if normalized != normalized_headword and normalized not in seen:
            seen.add(normalized)
            synonyms.append(synonym)
    examples = "; ".join(example.strip() for example in synset.examples())
    pos = {"noun": "noun", "verb": "verb", "adjective": "adj", "adverb": "adv"}[part_of_speech]
    return (f"headword={word} | pos={pos} | definition={definition['gloss']} | "
            f"synonyms={{{', '.join(synonyms)}}} | examples={{{examples}}}")


def package_model() -> dict[str, object]:
    if not MODEL.is_file():
        raise FileNotFoundError(f"Missing exported Glite LENS model: path={MODEL}")
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
    metadata: dict[str, str] = {}
    for name in ("tokenizer.json", "tokenizer_config.json"):
        shutil.copyfile(SOURCE / name, DESTINATION / name)
        metadata[name] = sha256(DESTINATION / name)
    return {"model": "Glite LENS seed-42", "revision": REVISION, "license": "CC-BY-NC-4.0",
            "quantization": "dynamic-uint8", "size": MODEL.stat().st_size,
            "parts": parts, "metadata": metadata}


def package_vectors() -> dict[str, object]:
    nltk.data.path.insert(0, str(WSD_ROOT / ".cache" / "nltk"))
    if not GLOSS_MODEL.is_file():
        raise FileNotFoundError(f"Missing quantized Glite LENS gloss tower: path={GLOSS_MODEL}")
    bucket_entries: dict[str, dict[str, list[str]]] = {}
    texts: list[str] = []
    source_digest = hashlib.sha256()
    for source in sorted(WORDNET.glob("[0-9][0-9][0-9][0-9].json")):
        raw = source.read_bytes()
        source_digest.update(source.name.encode("ascii"))
        source_digest.update(raw)
        entries: dict[str, list[str]] = {}
        for entry in json.loads(raw):
            definitions = [(sense["partOfSpeech"], definition)
                           for sense in entry["senses"] for definition in sense["definitions"]]
            if len(definitions) < 2:
                continue
            entries[entry["word"]] = [definition["id"] for _, definition in definitions]
            texts.extend(structured_gloss(entry["word"], pos, definition) for pos, definition in definitions)
        bucket_entries[source.stem] = entries
    print(json.dumps({"stage": "glosses", "count": len(texts)}), flush=True)
    tokenizer = AutoTokenizer.from_pretrained(str(BASE), local_files_only=True)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    session = ort.InferenceSession(str(GLOSS_MODEL), sess_options=options, providers=["CPUExecutionProvider"])
    model_hash = sha256(GLOSS_MODEL)
    source_hash = source_digest.hexdigest()
    completed = 0
    if VECTOR_PROGRESS.is_file():
        progress = json.loads(VECTOR_PROGRESS.read_text(encoding="utf-8"))
        if progress.get("count") == len(texts) and progress.get("model_sha256") == model_hash \
                and progress.get("source_sha256") == source_hash \
                and VECTOR_WORK.is_file() and VECTOR_WORK.stat().st_size == len(texts) * VECTOR_SIZE * 2:
            completed = int(progress["completed"])
    if not 0 <= completed <= len(texts):
        raise ValueError(f"Invalid Glite LENS vector progress: completed={completed} total={len(texts)}")
    vectors = np.memmap(VECTOR_WORK, dtype="<f2", mode="r+" if completed else "w+",
                        shape=(len(texts), VECTOR_SIZE))
    lengths: list[int] = []
    tokenizing_started = time.monotonic()
    for first in range(0, len(texts), 256):
        lengths.extend(len(ids) for ids in tokenizer(texts[first:first + 256], add_special_tokens=True,
                                                     truncation=True, max_length=512)["input_ids"])
        if first % 3200 == 0 or first + 256 >= len(texts):
            report_progress("Glite LENS tokenization", min(first + 256, len(texts)), len(texts), tokenizing_started, 0)
    order = np.argsort(np.asarray(lengths), kind="stable")
    encoding_started = time.monotonic()
    report_progress("Glite LENS embeddings", completed, len(order), encoding_started, completed)
    for offset in range(completed, len(order), 64):
        indices = order[offset:offset + 64]
        encoded = tokenizer([texts[index] for index in indices], padding=True, truncation=True,
                            max_length=512, return_tensors="np")
        hidden = session.run(None, {"input_ids": encoded["input_ids"].astype(np.int64),
                                    "attention_mask": encoded["attention_mask"].astype(np.int64)})[0]
        if hidden.shape != (len(indices), VECTOR_SIZE) or not np.isfinite(hidden).all():
            raise ValueError(f"Invalid Glite LENS gloss output: offset={offset} shape={hidden.shape}")
        vectors[indices] = hidden.astype(np.float16)
        if (offset + len(indices)) // 3200 > offset // 3200 or offset + len(indices) == len(order):
            vectors.flush()
            progress_path = VECTOR_PROGRESS.with_suffix(".tmp")
            progress_path.write_text(json.dumps({"count": len(texts), "model_sha256": model_hash,
                                                 "source_sha256": source_hash,
                                                 "completed": offset + len(indices)}) + "\n", encoding="utf-8")
            progress_path.replace(VECTOR_PROGRESS)
            report_progress("Glite LENS embeddings", offset + len(indices), len(texts), encoding_started, completed)
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
        raise ValueError(f"Glite LENS vector count mismatch: offset={global_offset} texts={len(texts)}")
    return {"format": "float16-le", "dimensions": VECTOR_SIZE, "count": len(texts),
            "sourceSha256": source_hash, "modelSha256": model_hash, "buckets": manifest}


def main() -> None:
    require_memory_scope()
    manifest = package_model()
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
