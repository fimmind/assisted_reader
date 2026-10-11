"""Generate missing browser WSD assets before build/deploy, reusing verified local files.

Only licenses and attribution belong in Git. Exports, tokenizers, manifests and
sense vectors are generated under public/wsd and copied into dist by Vite.
A process lock serializes builds; heavy stages run in separate subprocesses so
each encoder releases its memory before the next stage starts.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from typing import NotRequired, TypedDict, cast
from urllib.request import urlopen
import venv
import warnings

from wsd_memory import generation_budget, run_limited_generation
from wsd_exports import export_ready


ROOT = Path(__file__).resolve().parents[2]
WSD = ROOT / "wsd"
SCRIPTS = WSD / "scripts"
PYTHON = WSD / ".venv" / "bin" / "python"
ENVIRONMENT = {**os.environ, "OMP_NUM_THREADS": "4", "OPENBLAS_NUM_THREADS": "1",
               "TOKENIZERS_PARALLELISM": "false", "MALLOC_ARENA_MAX": "2"}


class ModelPart(TypedDict):
    name: str
    size: int
    sha256: str


class VectorPart(TypedDict):
    count: int
    bytes: int
    metadataSha256: str
    vectorsSha256: str


class VectorManifest(TypedDict):
    format: str
    dimensions: int
    count: int
    sourceSha256: NotRequired[str]
    buckets: dict[str, VectorPart]


class Manifest(TypedDict):
    revision: str
    size: int
    parts: list[ModelPart]
    metadata: dict[str, str]
    vectors: NotRequired[VectorManifest]


class Definition(TypedDict):
    id: str
    gloss: str


class Sense(TypedDict):
    definitions: list[Definition]


class Entry(TypedDict):
    word: str
    senses: list[Sense]


class AssetValidationError(ValueError):
    """A generated asset disagrees with its manifest or WordNet input."""


BucketIndex = dict[str, tuple[int, list[str]]]
REVISIONS: dict[str, str] = {
    "sayedshaun-wsd": "54e41c09c61ae8bd60c62e40bf483141c49ce0d3",
    "glite-lens": "glite-lens-seed42-context-int8-v1",
    "ettin-150m-wsd": "8751b577199d1bb95b74fa2457da7065d57100ae",
}


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


def wordnet_inputs() -> tuple[str, dict[str, BucketIndex]]:
    paths = sorted((ROOT / "data" / "wordnet").glob("[0-9][0-9][0-9][0-9].json"))
    if len(paths) != 1024:
        raise AssetValidationError(f"Expected 1024 WordNet buckets: actual={len(paths)}")
    result = hashlib.sha256()
    indices: dict[str, BucketIndex] = {}
    for path in paths:
        raw = path.read_bytes()
        result.update(path.name.encode("ascii"))
        result.update(raw)
        index: BucketIndex = {}
        offset = 0
        for entry in cast(list[Entry], json.loads(raw)):
            definitions = [definition for sense in entry["senses"] for definition in sense["definitions"]]
            if len(definitions) >= 2:
                index[entry["word"]] = (offset, [definition["id"] for definition in definitions])
                offset += len(definitions)
        indices[path.stem] = index
    return result.hexdigest(), indices


def check_file(path: Path, expected_digest: str, expected_size: int | None) -> None:
    if expected_size is not None and path.stat().st_size != expected_size:
        raise AssetValidationError(f"Generated asset size mismatch: path={path} expected={expected_size}")
    if digest(path) != expected_digest:
        raise AssetValidationError(f"Generated asset checksum mismatch: path={path}")


def check_package(name: str, source_hash: str, indices: dict[str, BucketIndex]) -> None:
    root = ROOT / "public" / "wsd" / name
    manifest_path = root / "manifest.json"
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise AssetValidationError(f"Generated manifest must be an object: model={name}")
    manifest = cast(Manifest, payload)
    if manifest["revision"] != REVISIONS[name] or not isinstance(manifest["parts"], list) or not manifest["parts"]:
        raise AssetValidationError(f"Generated model revision/parts mismatch: model={name}")
    expected_metadata = {"tokenizer.json", "tokenizer_config.json"}
    if name == "ettin-150m-wsd":
        expected_metadata.add("answer_letters.json")
    if not isinstance(manifest["metadata"], dict) or set(manifest["metadata"]) != expected_metadata:
        raise AssetValidationError(f"Generated model metadata is incomplete: model={name}")
    total = 0
    for index, part in enumerate(manifest["parts"]):
        if (not isinstance(part, dict) or part.get("name") != f"model.part{index:02d}"
                or not isinstance(part.get('size'), int) or part['size'] <= 0
                or not isinstance(part.get('sha256'), str)):
            raise AssetValidationError(f"Unexpected generated part name: model={name} index={index}")
        check_file(root / part["name"], part["sha256"], part["size"])
        total += part["size"]
    if total != manifest["size"]:
        raise AssetValidationError(f"Generated model size mismatch: model={name}")
    for filename, expected in manifest["metadata"].items():
        if filename not in ("tokenizer.json", "tokenizer_config.json", "answer_letters.json"):
            raise AssetValidationError(f"Unexpected generated metadata file: model={name} file={filename}")
        check_file(root / filename, expected, None)
    if name == "ettin-150m-wsd":
        return
    vectors = manifest["vectors"]
    if (not isinstance(vectors, dict) or vectors["format"] != "float16-le" or vectors["dimensions"] != 768
            or not isinstance(vectors['buckets'], dict)
            or set(vectors["buckets"]) != set(indices)):
        raise AssetValidationError(f"Invalid generated vector manifest: model={name}")
    if vectors.get("sourceSha256") != source_hash:
        raise AssetValidationError(f"WordNet changed; regenerate sense vectors: model={name}")
    total = 0
    for bucket, expected_index in indices.items():
        part = vectors["buckets"][bucket]
        if not isinstance(part, dict):
            raise AssetValidationError(f"Invalid generated vector declaration: model={name} bucket={bucket}")
        count = sum(len(ids) for _, ids in expected_index.values())
        if part["count"] != count or part["bytes"] != count * 768 * 2:
            raise AssetValidationError(f"Generated vector count mismatch: model={name} bucket={bucket}")
        index_path = root / "vectors" / f"{bucket}.json"
        check_file(index_path, part["metadataSha256"], None)
        check_file(root / "vectors" / f"{bucket}.bin", part["vectorsSha256"], part["bytes"])
        if json.loads(index_path.read_text(encoding="utf-8")) != json.loads(json.dumps(expected_index)):
            raise AssetValidationError(f"Generated vector IDs differ from WordNet: model={name} bucket={bucket}")
        total += count
    if total != vectors["count"]:
        raise AssetValidationError(f"Generated vector total mismatch: model={name}")


def package_ready(name: str, source_hash: str, indices: dict[str, BucketIndex]) -> bool:
    try:
        if (ROOT / "public" / "wsd" / name / ".building").exists():
            raise AssetValidationError(f"An earlier WSD build was interrupted: model={name}")
        check_package(name, source_hash, indices)
    except (FileNotFoundError, AssetValidationError, json.JSONDecodeError, KeyError) as error:
        print(json.dumps({"stage": "wsd-assets-need-generation", "model": name, "reason": str(error)}), flush=True)
        return False
    print(json.dumps({"stage": "wsd-assets-ready", "model": name}), flush=True)
    return True


def run(arguments: list[str]) -> None:
    started = time.monotonic()
    print(f"WSD stage: {' '.join(arguments[1:])}", flush=True)
    subprocess.run(arguments, cwd=ROOT, env=ENVIRONMENT, check=True)
    print(f"WSD stage complete ({time.monotonic() - started:.1f}s)", flush=True)


def ensure_environment() -> None:
    if not PYTHON.is_file():
        venv.EnvBuilder(with_pip=True).create(WSD / ".venv")
    probe = subprocess.run([str(PYTHON), "-c", "import torch, transformers, onnx, onnxruntime, nltk, numpy, huggingface_hub, onnxscript"],
                           cwd=ROOT, env=ENVIRONMENT, capture_output=True, text=True)
    if probe.returncode == 0:
        return
    print(json.dumps({"stage": "install-wsd-dependencies", "reason": probe.stderr}), flush=True)
    uv = shutil.which("uv") or str(WSD / ".venv" / "bin" / "uv")
    if not Path(uv).is_file():
        run([str(PYTHON), "-m", "pip", "install", "uv"])
    run([uv, "sync", "--frozen", "--project", str(WSD)])


def python_script(name: str, arguments: list[str]) -> None:
    run([str(PYTHON), str(SCRIPTS / name), *arguments])


def ensure_wordnet_corpus() -> None:
    destination = WSD / ".cache" / "nltk" / "corpora" / "wordnet.zip"
    expected = "cbda5ea6eef7f36a97a43d4a75f85e07fccbb4f23657d27b4ccbc93e2646ab59"
    if destination.is_file() and digest(destination) == expected:
        return
    url = "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/wordnet.zip"
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".tmp")
    for attempt in range(1, 4):
        try:
            with urlopen(url, timeout=120) as response, temporary.open("wb") as target:
                shutil.copyfileobj(response, target, 1024 * 1024)
            check_file(temporary, expected, None)
            temporary.replace(destination)
            return
        except (OSError, AssetValidationError) as error:
            warnings.warn(f"WordNet download failed: url={url} attempt={attempt} error={error!r}", stacklevel=2)
            if attempt == 3:
                raise
            time.sleep(2**attempt)


def build_sayedshaun() -> None:
    export = WSD / ".cache" / "exports" / "sayedshaun-wsd"
    if not export_ready(export, 'model-export.json', ['model-int8.onnx', 'tokenizer.json', 'tokenizer_config.json'],
                        SCRIPTS / 'export_sayedshaun_web.py'):
        python_script("download_models.py", ["sayedshaun-wsd", "sayedshaun-distilbert-base"])
        python_script("export_sayedshaun_web.py", ["--output", str(export)])
    python_script("package_sayedshaun_web.py", [])


def build_glite() -> None:
    export = WSD / ".cache" / "exports" / "glite-lens"
    base = WSD / ".cache" / "models" / "glite-lens-base"
    context_ready = export_ready(export, 'model-export.json', ['model-int8.onnx', 'tokenizer.json', 'tokenizer_config.json'],
                                 SCRIPTS / 'export_glite_lens_web.py')
    gloss_ready = export_ready(export, 'gloss-export.json', ['gloss-int8.onnx'], SCRIPTS / 'export_glite_lens_gloss.py')
    if not context_ready or not gloss_ready or not all((base / name).is_file() for name in
                                                      ('config.json', 'tokenizer.json', 'tokenizer_config.json')):
        python_script("download_glite_lens.py", [])
    if not context_ready:
        python_script("export_glite_lens_web.py", ["--output", str(export)])
    if not gloss_ready:
        python_script("export_glite_lens_gloss.py", ["--output", str(export)])
    ensure_wordnet_corpus()
    python_script("package_glite_lens_web.py", [])


def build_ettin() -> None:
    export = WSD / ".cache" / "exports" / "ettin-150m-wsd"
    source = WSD / ".cache" / "models" / "ettin-150m-wsd"
    ready = export_ready(export, 'model-export.json', ['model-int8.onnx'], SCRIPTS / 'export_ettin_web.py')
    if not all((source / name).is_file() for name in ("tokenizer.json", "tokenizer_config.json", "answer_letters.json")) or not ready:
        python_script("download_models.py", ["ettin-150m-wsd"])
    if not ready:
        python_script("export_ettin_web.py", ["--output", str(export)])
    python_script("package_ettin_web.py", [])


def main() -> None:
    (WSD / ".cache").mkdir(parents=True, exist_ok=True)
    with (WSD / ".cache" / "wsd-web-build.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        source_hash, indices = wordnet_inputs()
        for name in REVISIONS:
            for filename in ('LICENSE', 'NOTICE.txt'):
                asset = ROOT / 'public' / 'wsd' / name / filename
                if not asset.is_file() or asset.stat().st_size == 0:
                    raise FileNotFoundError(f"Tracked WSD attribution file missing: {asset}. Restore it from Git before generating assets.")
        missing = [name for name in REVISIONS if not package_ready(name, source_hash, indices)]
        if not missing:
            return
        budget = generation_budget()
        run_limited_generation([sys.executable, str(SCRIPTS / 'generate_wsd_web.py'), *missing],
                               budget, ENVIRONMENT, ROOT)


if __name__ == "__main__":
    main()
