"""Measure native ONNX margins for comparison with browser WASM calibration."""

from __future__ import annotations

import json
from math import ceil
from pathlib import Path

import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

from sayedshaun_wsd import marked_context


ROOT = Path(__file__).resolve().parents[1]
EXPORT = ROOT / ".cache" / "exports" / "sayedshaun-wsd"
CALIBRATION = ROOT / "data" / "processed" / "raganato-semeval2007.jsonl"
OUTPUT = ROOT / "results" / "sayedshaun-onnx-calibration.json"


def encode(session: ort.InferenceSession, tokenizer: object, texts: list[str]) -> np.ndarray:
    vectors: list[np.ndarray] = []
    for offset in range(0, len(texts), 32):
        encoded = tokenizer(
            texts[offset:offset + 32], padding=True, truncation=True,
            max_length=256, return_tensors="np",
        )
        vectors.append(session.run(None, {
            "input_ids": encoded["input_ids"].astype(np.int64),
            "attention_mask": encoded["attention_mask"].astype(np.int64),
        })[0])
    return np.concatenate(vectors)


def main() -> None:
    if not (EXPORT / "model-int8.onnx").is_file():
        raise FileNotFoundError(f"Missing quantized SayedShaun export: {EXPORT}")
    examples = [json.loads(line) for line in CALIBRATION.read_text().splitlines() if line.strip()]
    tokenizer = AutoTokenizer.from_pretrained(str(EXPORT), local_files_only=True)
    session = ort.InferenceSession(str(EXPORT / "model-int8.onnx"), providers=["CPUExecutionProvider"])
    glosses = list(dict.fromkeys(candidate["gloss"] for example in examples for candidate in example["candidates"]))
    vectors = encode(session, tokenizer, glosses)
    by_gloss = dict(zip(glosses, vectors))
    contexts = encode(session, tokenizer, [marked_context(example) for example in examples])
    gaps: list[float] = []
    for example, context in zip(examples, contexts):
        scores = [float(by_gloss[candidate["gloss"]] @ context) for candidate in example["candidates"]]
        gold = set(example["gold"])
        gold_scores = [score for score, candidate in zip(scores, example["candidates"]) if candidate["sense_id"] in gold]
        if not gold_scores:
            raise ValueError(f"Calibration example has no gold candidate: id={example['id']}")
        gaps.append(max(scores) - max(gold_scores))
    ordered = sorted(gaps)
    margins = [ordered[-1] if level == 0 else ordered[ceil((len(ordered) + 1) * (1 - level / 100)) - 1] for level in range(11)]
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps({
        "model": "sayedshaun-wsd-int8",
        "calibration_examples": len(examples),
        "margins": margins,
    }, indent=2) + "\n")
    print(json.dumps({"output": str(OUTPUT), "examples": len(examples), "margins": margins}))


if __name__ == "__main__":
    main()
