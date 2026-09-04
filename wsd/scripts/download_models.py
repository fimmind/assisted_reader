from __future__ import annotations

import argparse
from pathlib import Path

from huggingface_hub import snapshot_download

ROOT = Path(__file__).resolve().parents[1]
MODELS = {
    "e5-small": "intfloat/e5-small-v2",
    "wordnet-sense-embedding": "marksverdhei/wordnet-sense-embedding",
    "minilm": "sentence-transformers/all-MiniLM-L6-v2",
    "wsl-retriever": "Babelscape/wsl-retriever-e5-base-v2",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("model", nargs="+", choices=sorted(MODELS))
    args = parser.parse_args()
    target_root = ROOT / ".cache" / "models"
    for name in args.model:
        target = target_root / name
        print(f"downloading {MODELS[name]} to {target}")
        snapshot_download(MODELS[name], local_dir=target)


if __name__ == "__main__":
    main()
