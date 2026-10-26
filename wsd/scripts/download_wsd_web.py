"""Download and verify published WSD packages on Android Termux."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
from typing import TypedDict, cast
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import warnings

from ensure_wsd_web import (
    ROOT, REVISIONS, AssetValidationError, Manifest, check_package, wordnet_inputs,
)


MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_UNSIZED_ASSET_BYTES = 64 * 1024 * 1024
DOWNLOAD_WORKERS = 8
CHUNK_BYTES = 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 60
DOWNLOAD_ATTEMPTS = 3
BUILD_MARKER_PREFIX = "Downloading verified WSD assets from "
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")


class DownloadAsset(TypedDict):
    relative_path: str
    sha256: str
    size: int | None


def is_record(value: object, context: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise AssetValidationError(f"Expected an object: context={context}")
    return cast(dict[str, object], value)


def is_sha256(value: object, context: str) -> str:
    if not isinstance(value, str) or not SHA256_PATTERN.fullmatch(value):
        raise AssetValidationError(f"Invalid SHA-256: context={context}")
    return value


def positive_integer(value: object, context: str, allow_zero: bool) -> int:
    minimum = 0 if allow_zero else 1
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise AssetValidationError(f"Invalid integer: context={context} value={value!r}")
    return value


def error_details(error: Exception) -> dict[str, int | str]:
    if isinstance(error, HTTPError):
        body = error.read(4096).decode("utf-8", errors="replace")
        return {"status": error.code, "url": error.url, "reason": str(error.reason), "body": body}
    return {"message": str(error), "type": type(error).__name__}


def package_downloads(
    manifest_value: object,
    model_name: str,
    expected_revision: str,
    expected_wordnet_hash: str,
) -> tuple[list[DownloadAsset], Manifest]:
    manifest = is_record(manifest_value, f"model={model_name} manifest")
    if manifest.get("revision") != expected_revision:
        raise AssetValidationError(
            f"Published model revision differs: model={model_name} expected={expected_revision} "
            f"actual={manifest.get('revision')!r}"
        )

    raw_parts = manifest.get("parts")
    if not isinstance(raw_parts, list) or not raw_parts or len(raw_parts) > 20:
        raise AssetValidationError(f"Invalid model parts: model={model_name}")
    assets: list[DownloadAsset] = []
    model_bytes = 0
    for index, raw_part in enumerate(raw_parts):
        part = is_record(raw_part, f"model={model_name} part={index}")
        expected_name = f"model.part{index:02d}"
        if part.get("name") != expected_name:
            raise AssetValidationError(
                f"Invalid model part path: model={model_name} expected={expected_name} "
                f"actual={part.get('name')!r}"
            )
        part_size = positive_integer(part.get("size"), f"model={model_name} part={expected_name} size", False)
        assets.append({
            "relative_path": expected_name,
            "sha256": is_sha256(part.get("sha256"), f"model={model_name} part={expected_name}"),
            "size": part_size,
        })
        model_bytes += part_size
    declared_model_bytes = positive_integer(manifest.get("size"), f"model={model_name} size", False)
    if model_bytes != declared_model_bytes:
        raise AssetValidationError(
            f"Model part sizes disagree: model={model_name} declared={declared_model_bytes} actual={model_bytes}"
        )

    metadata = is_record(manifest.get("metadata"), f"model={model_name} metadata")
    expected_metadata_names = {"tokenizer.json", "tokenizer_config.json"}
    if set(metadata) != expected_metadata_names:
        raise AssetValidationError(f"Invalid model metadata files: model={model_name}")
    for filename in sorted(expected_metadata_names):
        assets.append({
            "relative_path": filename,
            "sha256": is_sha256(metadata[filename], f"model={model_name} metadata={filename}"),
            "size": None,
        })

    vectors = is_record(manifest.get("vectors"), f"model={model_name} vectors")
    if vectors.get("format") != "float16-le" or vectors.get("dimensions") != 768:
        raise AssetValidationError(f"Invalid vector format or dimensions: model={model_name}")
    if vectors.get("sourceSha256") != expected_wordnet_hash:
        raise AssetValidationError(
            f"Published sense vectors use different WordNet data: model={model_name} "
            f"expected={expected_wordnet_hash} actual={vectors.get('sourceSha256')!r}"
        )
    vector_count = positive_integer(vectors.get("count"), f"model={model_name} vector count", allow_zero=True)
    buckets = is_record(vectors.get("buckets"), f"model={model_name} vector buckets")
    expected_buckets = {f"{index:04d}" for index in range(1024)}
    if set(buckets) != expected_buckets:
        raise AssetValidationError(f"Invalid vector bucket set: model={model_name}")
    actual_vector_count = 0
    for bucket_name in sorted(expected_buckets):
        bucket = is_record(buckets[bucket_name], f"model={model_name} bucket={bucket_name}")
        bucket_count = positive_integer(
            bucket.get("count"), f"model={model_name} bucket={bucket_name} count", allow_zero=True,
        )
        expected_bytes = bucket_count * 768 * 2
        bucket_bytes = positive_integer(
            bucket.get("bytes"), f"model={model_name} bucket={bucket_name} bytes", allow_zero=True,
        )
        if bucket_bytes != expected_bytes:
            raise AssetValidationError(
                f"Invalid vector bucket size: model={model_name} bucket={bucket_name} "
                f"expected={expected_bytes} actual={bucket_bytes}"
            )
        assets.append({
            "relative_path": f"vectors/{bucket_name}.json",
            "sha256": is_sha256(bucket.get("metadataSha256"), f"model={model_name} bucket={bucket_name} metadata"),
            "size": None,
        })
        assets.append({
            "relative_path": f"vectors/{bucket_name}.bin",
            "sha256": is_sha256(bucket.get("vectorsSha256"), f"model={model_name} bucket={bucket_name} vectors"),
            "size": bucket_bytes,
        })
        actual_vector_count += bucket_count
    if actual_vector_count != vector_count:
        raise AssetValidationError(
            f"Vector bucket counts disagree: model={model_name} "
            f"declared={vector_count} actual={actual_vector_count}"
        )
    return assets, cast(Manifest, manifest)


def fetch_manifest(url: str) -> object:
    last_error: Exception | None = None
    for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
        try:
            request = Request(url, headers={"User-Agent": "assisted-reader-wsd-asset-sync/1"})
            with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                content_length = response.headers.get("Content-Length")
                if content_length is not None and int(content_length) > MAX_MANIFEST_BYTES:
                    raise AssetValidationError(
                        f"Published manifest is too large: url={url} bytes={content_length} "
                        f"limit={MAX_MANIFEST_BYTES}"
                    )
                payload = response.read(MAX_MANIFEST_BYTES + 1)
            if len(payload) > MAX_MANIFEST_BYTES:
                raise AssetValidationError(
                    f"Published manifest exceeds size limit: url={url} limit={MAX_MANIFEST_BYTES}"
                )
            try:
                return json.loads(payload)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise AssetValidationError(f"Invalid published manifest: url={url} error={error}") from error
        except (HTTPError, URLError, TimeoutError, OSError, AssetValidationError, ValueError) as error:
            last_error = error
            warnings.warn(
                json.dumps({"stage": "wsd-manifest-download-failed", "url": url,
                            "attempt": attempt, "attempts": DOWNLOAD_ATTEMPTS,
                            "error": error_details(error)}),
                stacklevel=2,
            )
            if attempt < DOWNLOAD_ATTEMPTS:
                time.sleep(2**attempt)
    if last_error is None:
        raise RuntimeError(f"Manifest download failed without an exception: url={url}")
    raise last_error


def file_matches(path: Path, asset: DownloadAsset) -> bool:
    try:
        if not path.is_file():
            return False
        if asset["size"] is not None and path.stat().st_size != asset["size"]:
            return False
        digest = hashlib.sha256()
        with path.open("rb") as source:
            while chunk := source.read(CHUNK_BYTES):
                digest.update(chunk)
        return digest.hexdigest() == asset["sha256"]
    except OSError:
        return False


def download_asset(base_url: str, root: Path, asset: DownloadAsset) -> None:
    relative_path = asset["relative_path"]
    url = f"{base_url}/{relative_path}"
    destination = root / relative_path
    temporary = destination.with_name(f"{destination.name}.download")
    destination.parent.mkdir(parents=True, exist_ok=True)
    expected_size = asset["size"]
    maximum_size = expected_size if expected_size is not None else MAX_UNSIZED_ASSET_BYTES
    last_error: Exception | None = None
    for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
        try:
            digest = hashlib.sha256()
            downloaded = 0
            request = Request(url, headers={"User-Agent": "assisted-reader-wsd-asset-sync/1"})
            with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response, temporary.open("wb") as target:
                content_length = response.headers.get("Content-Length")
                if content_length is not None and int(content_length) > maximum_size:
                    raise AssetValidationError(
                        f"Asset exceeds declared size: url={url} expected={maximum_size} response={content_length}"
                    )
                while chunk := response.read(CHUNK_BYTES):
                    downloaded += len(chunk)
                    if downloaded > maximum_size:
                        raise AssetValidationError(
                            f"Asset exceeds size limit: url={url} limit={maximum_size} downloaded={downloaded}"
                        )
                    digest.update(chunk)
                    target.write(chunk)
            if expected_size is not None and downloaded != expected_size:
                raise AssetValidationError(
                    f"Asset size mismatch: url={url} expected={expected_size} actual={downloaded}"
                )
            actual_digest = digest.hexdigest()
            if actual_digest != asset["sha256"]:
                raise AssetValidationError(
                    f"Asset checksum mismatch: url={url} expected={asset['sha256']} actual={actual_digest}"
                )
            os.replace(temporary, destination)
            return
        except (HTTPError, URLError, TimeoutError, OSError, AssetValidationError, ValueError) as error:
            last_error = error
            temporary.unlink(missing_ok=True)
            warnings.warn(
                json.dumps({"stage": "wsd-asset-download-failed", "url": url,
                            "attempt": attempt, "attempts": DOWNLOAD_ATTEMPTS,
                            "error": error_details(error)}),
                stacklevel=2,
            )
            if attempt < DOWNLOAD_ATTEMPTS:
                time.sleep(2**attempt)
    if last_error is None:
        raise RuntimeError(f"Asset download failed without an exception: url={url}")
    raise last_error


def download_package(root: Path, model_name: str, wordnet_hash: str) -> None:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    homepage = package.get("homepage")
    if not isinstance(homepage, str) or not homepage.startswith("https://"):
        raise ValueError(f"A secure HTTPS package homepage is required: actual={homepage!r}")
    model_root = root / model_name
    base_url = f"{homepage.rstrip('/')}/wsd/{model_name}"
    manifest_url = f"{base_url}/manifest.json"
    remote_manifest = fetch_manifest(manifest_url)
    assets, manifest = package_downloads(
        remote_manifest,
        model_name,
        REVISIONS[model_name],
        wordnet_hash,
    )
    for name in ("LICENSE", "NOTICE.txt"):
        if not (model_root / name).is_file():
            raise FileNotFoundError(f"Tracked WSD attribution file is missing: path={model_root / name}")
    pending_assets: list[DownloadAsset] = []
    for asset in assets:
        path = model_root / asset["relative_path"]
        if not file_matches(path, asset):
            pending_assets.append(asset)
    if pending_assets:
        print(json.dumps({"stage": "wsd-assets-files", "model": model_name,
                          "pending": len(pending_assets), "total": len(assets)}), flush=True)
        with ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS) as executor:
            futures = [executor.submit(download_asset, base_url, model_root, asset) for asset in pending_assets]
            for completed, future in enumerate(as_completed(futures), start=1):
                future.result()
                if completed % 32 == 0 or completed == len(futures):
                    print(json.dumps({"stage": "wsd-assets-progress", "model": model_name,
                                      "completed": completed, "pending": len(futures)}), flush=True)
    manifest_path = model_root / "manifest.json"
    temporary_manifest = manifest_path.with_name("manifest.json.download")
    temporary_manifest.write_text(json.dumps(manifest, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(temporary_manifest, manifest_path)


def download_models(model_names: list[str]) -> None:
    root = ROOT / "public" / "wsd"
    source_hash, indices = wordnet_inputs()
    for model_name in model_names:
        if model_name not in REVISIONS:
            raise ValueError(f"Unsupported WSD model: model={model_name}")
        model_root = root / model_name
        model_root.mkdir(parents=True, exist_ok=True)
        marker = model_root / ".building"
        marker.write_text(f"{BUILD_MARKER_PREFIX}{model_name}\n", encoding="utf-8")
        print(json.dumps({"stage": "wsd-assets-downloading", "model": model_name}), flush=True)
        download_package(root, model_name, source_hash)
        check_package(model_name, source_hash, indices)
        marker.unlink()
        print(json.dumps({"stage": "wsd-assets-ready", "model": model_name}), flush=True)


def main() -> None:
    model_names = sys.argv[1:]
    if not model_names:
        raise ValueError("At least one WSD model must be selected for download.")
    download_models(model_names)


if __name__ == "__main__":
    main()
