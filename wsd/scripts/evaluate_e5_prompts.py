from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer

from filtering import ScoredExample, filtering_metrics, fixed_top_k, runtime_example
from rankers import MODEL_ROOT, reciprocal_rank_fusion_scores


ROOT = Path(__file__).resolve().parents[1]


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def marked_context(example: dict) -> str:
    pattern = re.compile(re.escape(example["target"]), re.IGNORECASE)
    return pattern.sub(
        f"[TARGET] {example['target']} [/TARGET]",
        example["context"],
        count=1,
    )


def prompt_inputs(name: str, examples: list[dict]) -> list[str]:
    builders = {
        "current": lambda example: (
            f"query: Target word: {example['target']}. Context: {example['context']}"
        ),
        "natural-question": lambda example: (
            f"query: What does '{example['target']}' mean in this sentence? {example['context']}"
        ),
        "context-only": lambda example: f"query: {example['context']}",
        "concise-target": lambda example: (
            f"query: {example['target']}: {example['context']}"
        ),
        "marked-target": lambda example: f"query: {marked_context(example)}",
    }
    return [builders[name](example) for example in examples]


def semantic_scores(
    context_embeddings: np.ndarray,
    gloss_embeddings: np.ndarray,
    examples: list[dict],
) -> list[list[float]]:
    scores: list[list[float]] = []
    offset = 0
    for example, context_embedding in zip(examples, context_embeddings):
        count = len(example["candidates"])
        scores.append(
            (gloss_embeddings[offset:offset + count] @ context_embedding).tolist()
        )
        offset += count
    return scores


def metrics_for_split(scored: list[ScoredExample], split: str) -> dict[str, float | int]:
    selected = [
        item for item in scored if item.example.get("benchmark_split") == split
    ]
    return filtering_metrics(
        selected,
        [fixed_top_k(item.scores, 3) for item in selected],
    )


def selection_key(row: dict[str, float | int | str]) -> tuple[int, int, float, str]:
    return (
        int(row["unsafe_exclusions"]),
        int(row["all_fits_hidden"]),
        -float(row["acceptable_definition_recall"]),
        str(row["prompt"]),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    args = parser.parse_args()
    path = ROOT / "data" / "processed" / f"{args.dataset}.jsonl"
    examples = [runtime_example(example) for example in read_jsonl(path)]
    model = SentenceTransformer(
        str(MODEL_ROOT / "e5-small"),
        local_files_only=True,
    )
    glosses = [
        f"passage: {candidate['gloss']}"
        for example in examples
        for candidate in example["candidates"]
    ]
    gloss_embeddings = np.asarray(model.encode(
        glosses,
        batch_size=256,
        normalize_embeddings=True,
        show_progress_bar=False,
    ))
    rows: list[dict[str, float | int | str]] = []
    scored_by_prompt: dict[str, list[ScoredExample]] = {}
    for prompt_name in (
        "current",
        "natural-question",
        "context-only",
        "concise-target",
        "marked-target",
    ):
        context_embeddings = np.asarray(model.encode(
            prompt_inputs(prompt_name, examples),
            batch_size=256,
            normalize_embeddings=True,
            show_progress_bar=False,
        ))
        semantic = semantic_scores(context_embeddings, gloss_embeddings, examples)
        fused = [
            reciprocal_rank_fusion_scores(example, scores, 60, 0.5)
            for example, scores in zip(examples, semantic)
        ]
        scored = [
            ScoredExample(example=example, scores=scores)
            for example, scores in zip(examples, fused)
        ]
        scored_by_prompt[prompt_name] = scored
        rows.append({
            "prompt": prompt_name,
            "slice": "calibration",
            **metrics_for_split(scored, "calibration"),
        })
    calibration_rows = sorted(rows, key=selection_key)
    selected_prompt = str(calibration_rows[0]["prompt"])
    held_out = {
        "prompt": selected_prompt,
        "slice": "evaluation",
        **metrics_for_split(scored_by_prompt[selected_prompt], "evaluation"),
    }
    rows.append(held_out)

    output = ROOT / "results" / f"{args.dataset}-e5-prompt-search.csv"
    with output.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(
            destination,
            fieldnames=sorted({key for row in rows for key in row}),
        )
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps({
        "calibration": calibration_rows,
        "selected_prompt": selected_prompt,
        "held_out_evaluation": held_out,
        "output": str(output.relative_to(ROOT)),
    }, indent=2))


if __name__ == "__main__":
    main()
