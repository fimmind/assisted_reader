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
    "nli-minilm2-int8": "cross-encoder/nli-MiniLM2-L6-H768",
    "distilbert-mnli-int8": "Xenova/distilbert-base-uncased-mnli",
    "mobilebert-mnli-q4f16": "Xenova/mobilebert-uncased-mnli",
    "ettin-150m-wsd": "sign/Ettin-150m-WSD",
    "modernbert-large-wsd": "sign/ModernBERT-Large-Instruct-WSD",
    "sayedshaun-wsd": "SayedShaun/word-sense-disambiguation",
    "sayedshaun-distilbert-base": "distilbert/distilbert-base-uncased",
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
    "1_WordPooling/*",
    "2_Transformer/*",
    "3_WordPooling/*",
]
MODEL_REVISIONS = {
    "wordnet-sense-embedding": "ff56883911136c0622c8f66e4035f989abe14f58",
    "nli-minilm2-int8": "b95119ce93d3e065de6214e38cd4a97b0f2f2c6d",
    "distilbert-mnli-int8": "fddd480db7392a87114a6813c6acb5ede13ff4ee",
    "mobilebert-mnli-q4f16": "8b0ea66ab7b190bba77418ba03b67d69cfc9a1ee",
    "ettin-150m-wsd": "8751b577199d1bb95b74fa2457da7065d57100ae",
    "modernbert-large-wsd": "e26867fb25a86e7491b9f08a0216e93dcff3dec0",
    "sayedshaun-wsd": "54e41c09c61ae8bd60c62e40bf483141c49ce0d3",
    "sayedshaun-distilbert-base": "12040accade4e8a0f71eabdb258fecc2e7e948be",
}
ONNX_METADATA_FILES = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.txt",
    "vocab.json",
    "merges.txt",
    "special_tokens_map.json",
]
MODEL_FILE_OVERRIDES = {
    "nli-minilm2-int8": ONNX_METADATA_FILES + ["onnx/model_quint8_avx2.onnx"],
    "distilbert-mnli-int8": ONNX_METADATA_FILES + ["onnx/model_int8.onnx"],
    "mobilebert-mnli-q4f16": ONNX_METADATA_FILES + ["onnx/model_q4f16.onnx"],
    "ettin-150m-wsd": ONNX_METADATA_FILES + ["answer_letters.json", "model.safetensors"],
    "modernbert-large-wsd": ONNX_METADATA_FILES + ["answer_letters.json", "model.safetensors"],
    "sayedshaun-wsd": ["cosine/step-12000-f1-0.8066.pt"],
    "sayedshaun-distilbert-base": ["config.json", "tokenizer.json", "tokenizer_config.json", "vocab.txt", "special_tokens_map.json"],
}


def download_model(repository: str, target: Path, revision: str | None, patterns: list[str]) -> None:
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            snapshot_download(repository, local_dir=target, revision=revision, allow_patterns=patterns)
            weight_files = [
                *target.glob("*.safetensors"),
                *target.glob("*.bin"),
                *target.glob("onnx/*.onnx"),
                *target.glob("cosine/*.pt"),
            ]
            if repository == "distilbert/distilbert-base-uncased":
                required = [target / "config.json", target / "tokenizer.json"]
                missing = [str(path) for path in required if not path.is_file()]
                if missing:
                    raise FileNotFoundError(
                        f"Downloaded base tokenizer is incomplete: repository={repository!r}, "
                        f"missing={missing}"
                    )
            elif not weight_files:
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
        download_model(
            MODELS[name],
            target,
            MODEL_REVISIONS.get(name),
            MODEL_FILE_OVERRIDES.get(name, MODEL_FILES),
        )


if __name__ == "__main__":
    main()
