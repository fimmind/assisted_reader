from __future__ import annotations

import argparse
import time
import warnings
from pathlib import Path

from huggingface_hub import snapshot_download

ROOT = Path(__file__).resolve().parents[1]
MODELS = {
    "arctic-embed-xs": "Snowflake/snowflake-arctic-embed-xs",
    "e5-small": "intfloat/e5-small-v2",
    "minilm-l2-cross-encoder": "cross-encoder/ms-marco-MiniLM-L2-v2",
    "minilm-l6-cross-encoder": "cross-encoder/ms-marco-MiniLM-L6-v2",
    "wordnet-sense-embedding": "marksverdhei/wordnet-sense-embedding",
    "minilm": "sentence-transformers/all-MiniLM-L6-v2",
    "tinybert-cross-encoder": "cross-encoder/ms-marco-TinyBERT-L2-v2",
    "wsl-retriever": "Babelscape/wsl-retriever-e5-base-v2",
}
MODEL_FILES = [
    "*.bin",
    "*.json",
    "*.model",
    "*.safetensors",
    "*.txt",
    "1_Pooling/*",
    "README.md",
    "modules.json",
    "sentence_bert_config.json",
    "word_pooling.py",
]


def download_model(repository: str, target: Path) -> None:
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            snapshot_download(repository, local_dir=target, allow_patterns=MODEL_FILES)
            weight_files = [
                *target.glob("*.safetensors"),
                *target.glob("*.bin"),
            ]
            if not weight_files:
                raise FileNotFoundError(
                    f"Downloaded model has no weight file: repository={repository!r}, "
                    f"target={str(target)!r}; the repository may require access approval"
                )
            return
        except Exception as error:
            last_error = error
            warnings.warn(
                f"Model download failed: repository={repository!r}, target={str(target)!r}, "
                f"attempt={attempt}/3, error={error!r}",
                stacklevel=2,
            )
            if attempt < 3:
                time.sleep(2**attempt)
    if last_error is None:
        raise RuntimeError(f"Model download failed without an exception: repository={repository!r}")
    raise last_error


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("model", nargs="+", choices=sorted(MODELS))
    args = parser.parse_args()
    target_root = ROOT / ".cache" / "models"
    for name in args.model:
        target = target_root / name
        print(f"downloading {MODELS[name]} to {target}")
        download_model(MODELS[name], target)


if __name__ == "__main__":
    main()
