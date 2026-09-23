"""Make a reproducible, corpus-balanced WordNet filtering benchmark subset."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1] / "data" / "processed"
CALIBRATION = ("semeval2007", 150)
EVALUATION = ("senseval2", "senseval3", "semeval2013", "semeval2015")
EVALUATION_PER_CORPUS = 63


def read_examples(name: str) -> list[dict]:
    path = ROOT / f"raganato-{name}.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def sample_examples(name: str, count: int) -> list[dict]:
    examples = read_examples(name)
    if len(examples) < count:
        raise ValueError(f"Raganato corpus has too few examples: corpus={name} actual={len(examples)} required={count}")
    selected = sorted(
        examples,
        key=lambda example: hashlib.sha256(f"{name}:{example['id']}".encode("utf-8")).hexdigest(),
    )[:count]
    return [{**example, "id": f"raganato-{name}:{example['id']}"} for example in selected]


def write_examples(name: str, examples: list[dict]) -> None:
    path = ROOT / f"raganato-{name}.jsonl"
    path.write_text(
        "".join(json.dumps(example, ensure_ascii=True) + "\n" for example in examples),
        encoding="utf-8",
    )
    print(f"wrote {len(examples)} examples to {path}")


def main() -> None:
    calibration_name, calibration_count = CALIBRATION
    write_examples(
        f"{calibration_name}-sample-{calibration_count}",
        sample_examples(calibration_name, calibration_count),
    )
    heldout = [
        example
        for name in EVALUATION
        for example in sample_examples(name, EVALUATION_PER_CORPUS)
    ]
    write_examples(f"heldout-sample-{len(heldout)}", heldout)


if __name__ == "__main__":
    main()
