"""Download the pinned Glite LENS seed-42 model and its tokenizer files."""

from __future__ import annotations

import hashlib
import time
import warnings
from pathlib import Path
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
MODEL_ROOT = ROOT / ".cache" / "models"
GLITE_COMMIT = "5d3e2b640648a27af4dcf185bc373748afee9f9c"
BASE_REVISION = "8949b909ec900327062f0ebf497f51aef5e6f0c8"
RELEASE_PREFIX = (
    "tasks/t0034_glite_lens_canonical/assets/model/"
    "glite-lens-canonical-modernbert-v1/files"
)
MODEL_URL = (
    "https://media.githubusercontent.com/media/GliteTech/"
    f"research-semcor-relabeling/refs/heads/main/{RELEASE_PREFIX}/"
    "training_runs/lens-gpt55-s42/best_model.ckpt"
)
TOKENIZER_PREFIX = (
    "https://raw.githubusercontent.com/GliteTech/research-semcor-relabeling/"
    f"{GLITE_COMMIT}/{RELEASE_PREFIX}/tokenizers/answerdotai--ModernBERT-base"
)
BASE_PREFIX = f"https://huggingface.co/answerdotai/ModernBERT-base/resolve/{BASE_REVISION}"
ASSETS: tuple[tuple[str, Path, str], ...] = (
    (
        MODEL_URL,
        MODEL_ROOT / "glite-lens" / "best_model.ckpt",
        "4654117eefbdef5305461ba2d0fc7e7a4087718991f935fca2ae8cf5f64a102a",
    ),
    (
        f"{BASE_PREFIX}/config.json",
        MODEL_ROOT / "glite-lens-base" / "config.json",
        "1609d59e627c33eaed524b4f01e546d42e84190a079a5a5ded84b212c41c324f",
    ),
    (
        f"{BASE_PREFIX}/special_tokens_map.json",
        MODEL_ROOT / "glite-lens-base" / "special_tokens_map.json",
        "ea97ecdbcc73713039d8d64dbb05e3689495c96657fbd9a18f5bed381be81049",
    ),
    (
        f"{TOKENIZER_PREFIX}/tokenizer.json",
        MODEL_ROOT / "glite-lens-base" / "tokenizer.json",
        "27d80dd732aedfa7080f19d894d92dbc7e57005fc5aadd3c4d1c1ba49566b5a1",
    ),
    (
        f"{TOKENIZER_PREFIX}/tokenizer_config.json",
        MODEL_ROOT / "glite-lens-base" / "tokenizer_config.json",
        "3cd2017ff46d0a527e5d39cae39272eccfa1f19bb9f89b05d166aab2e38354e2",
    ),
)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def download_asset(url: str, path: Path, expected_sha256: str) -> None:
    if path.is_file():
        actual = file_sha256(path)
        if actual == expected_sha256:
            print(f"verified {path}")
            return
        raise ValueError(
            f"Existing Glite LENS asset has wrong SHA-256: path={path} "
            f"expected={expected_sha256} actual={actual}"
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            with urlopen(url, timeout=120) as source, temporary.open("wb") as destination:
                while chunk := source.read(1024 * 1024):
                    destination.write(chunk)
            actual = file_sha256(temporary)
            if actual != expected_sha256:
                raise ValueError(
                    f"Glite LENS asset SHA-256 mismatch: url={url} path={path} "
                    f"expected={expected_sha256} actual={actual}"
                )
            temporary.replace(path)
            print(f"downloaded {path}")
            return
        except (OSError, ValueError) as error:
            last_error = error
            warnings.warn(
                f"Glite LENS download failed: url={url} path={path} attempt={attempt}/3 "
                f"error={error!r}",
                stacklevel=2,
            )
            if attempt < 3:
                time.sleep(2**attempt)
    if last_error is None:
        raise RuntimeError(f"Glite LENS download failed without an error: url={url}")
    raise last_error


def main() -> None:
    for url, path, digest in ASSETS:
        download_asset(url, path, digest)


if __name__ == "__main__":
    main()
