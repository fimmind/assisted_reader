"""Prepare SayedShaun float16 gloss vectors for browser WASM calibration."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

from rankers import target_span, unique_inputs


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "processed" / "raganato-semeval2007.jsonl"
EXPORT = ROOT / ".cache" / "exports" / "sayedshaun-wsd"
OUTPUT = ROOT / ".cache" / "sayedshaun-calibration-input.json"


def main() -> None:
    examples = [json.loads(line) for line in SOURCE.read_text().splitlines() if line.strip()]
    texts = [candidate["gloss"] for example in examples for candidate in example["candidates"]]
    unique, inverse = unique_inputs(texts)
    tokenizer = AutoTokenizer.from_pretrained(str(EXPORT), local_files_only=True)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 8
    session = ort.InferenceSession(str(EXPORT / "model-int8.onnx"),
                                   sess_options=options, providers=["CPUExecutionProvider"])
    vectors = np.empty((len(unique), 768), dtype=np.float16)
    lengths = [len(ids) for ids in tokenizer(unique, add_special_tokens=True, truncation=True,
                                            max_length=256)["input_ids"]]
    order = np.argsort(np.asarray(lengths), kind="stable")
    for offset in range(0, len(order), 64):
        indices = order[offset:offset + 64]
        encoded = tokenizer([unique[index] for index in indices], padding=True, truncation=True,
                            max_length=256, return_tensors="np")
        hidden = session.run(None, {"input_ids": encoded["input_ids"].astype(np.int64),
                                    "attention_mask": encoded["attention_mask"].astype(np.int64)})[0]
        if hidden.shape != (len(indices), 768) or not np.isfinite(hidden).all():
            raise ValueError(f"Invalid SayedShaun calibration output: offset={offset} shape={hidden.shape}")
        vectors[indices] = hidden.astype(np.float16)
    prepared: list[dict[str, object]] = []
    position = 0
    for example in examples:
        start, end = target_span(example)
        count = len(example["candidates"])
        prepared.append({"id": example["id"], "text": example["context"], "start": start, "end": end,
                         "gold": [index for index, candidate in enumerate(example["candidates"])
                                  if candidate["sense_id"] in example["gold"]],
                         "vectors": vectors[np.asarray(inverse[position:position + count])].astype(np.float32).tolist()})
        position += count
    OUTPUT.write_text(json.dumps(prepared, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(OUTPUT), "examples": len(prepared), "unique_definitions": len(unique)}))


if __name__ == "__main__":
    main()
