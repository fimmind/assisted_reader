"""Calibrate the exported browser Ettin model on the held-out WSD split."""

from __future__ import annotations

import json
from math import ceil
from pathlib import Path

import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

from ettin_wsd import EttinWsdRanker


ROOT = Path(__file__).resolve().parents[1]
MODEL_ROOT = ROOT / ".cache" / "models" / "ettin-150m-wsd"
MODEL_PATH = ROOT / ".cache" / "exports" / "ettin-150m-wsd" / "model-int8.onnx"
OUTPUT = ROOT / "results" / "ettin-web-scores.json"
CALIBRATION = ROOT / "data" / "processed" / "raganato-semeval2007.jsonl"
EVALUATION = [
    ROOT / "data" / "processed" / f"raganato-{name}.jsonl"
    for name in ("senseval2", "senseval3", "semeval2013", "semeval2015")
]


def load_examples(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def main() -> None:
    if not MODEL_PATH.is_file():
        raise FileNotFoundError(f"Missing exported WSD model: {MODEL_PATH}")
    calibration = load_examples(CALIBRATION)
    evaluation = [example for path in EVALUATION for example in load_examples(path)]
    examples = calibration + evaluation
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ROOT, local_files_only=True)
    ranker = EttinWsdRanker.__new__(EttinWsdRanker)
    ranker.tokenizer = tokenizer
    ranker.letters = json.loads((MODEL_ROOT / "answer_letters.json").read_text())["letters"]
    session = ort.InferenceSession(str(MODEL_PATH), providers=["CPUExecutionProvider"])
    if OUTPUT.is_file():
        saved = json.loads(OUTPUT.read_text())
        scores = saved["scores"]
    else:
        scores = []

    for index in range(len(scores), len(examples)):
        example = examples[index]
        ids = np.array(
            [tokenizer(ranker.prompt(example), add_special_tokens=True, truncation=False)["input_ids"]],
            dtype=np.int64,
        )
        positions = np.flatnonzero(ids == tokenizer.mask_token_id)
        if len(positions) != 1:
            raise ValueError(f"Expected one mask in example {example['id']}")
        logits = session.run(None, {
            "input_ids": ids,
            "attention_mask": np.ones_like(ids),
            "prediction_positions": positions.astype(np.int64),
        })[0][0, :len(example["candidates"])]
        scores.append(logits.astype(float).tolist())
        if (index + 1) % 100 == 0 or index + 1 == len(examples):
            OUTPUT.write_text(json.dumps({"scores": scores}))
            print(f"Scored {index + 1}/{len(examples)}", flush=True)

    gaps = []
    for example, logits in zip(calibration, scores[:len(calibration)]):
        gold = set(example["gold"])
        best_gold = max(
            score for score, candidate in zip(logits, example["candidates"])
            if candidate["sense_id"] in gold
        )
        gaps.append(max(logits) - best_gold)
    ordered = sorted(gaps)
    for level in range(11):
        rank = len(ordered) if level == 0 else ceil((len(ordered) + 1) * (1 - level / 100))
        margin = ordered[rank - 1]
        shown = misses = nongold_total = nongold_removed = 0
        for example, logits in zip(evaluation, scores[len(calibration):]):
            best = max(logits)
            selected = [
                candidate for candidate, score in zip(example["candidates"], logits)
                if best - score <= margin
            ]
            gold = set(example["gold"])
            shown += len(selected)
            misses += not any(candidate["sense_id"] in gold for candidate in selected)
            nongold_total += sum(candidate["sense_id"] not in gold for candidate in example["candidates"])
            nongold_removed += sum(
                candidate["sense_id"] not in gold and best - score > margin
                for candidate, score in zip(example["candidates"], logits)
            )
        print(json.dumps({
            "level": level,
            "margin": margin,
            "mean_shown": shown / len(evaluation),
            "gold_misses": misses,
            "nongold_suppression": nongold_removed / nongold_total,
        }), flush=True)


if __name__ == "__main__":
    main()
