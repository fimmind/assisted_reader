from __future__ import annotations

import argparse
import json
import math
import random
from dataclasses import dataclass
from functools import partial
from pathlib import Path

import torch
from transformers import PreTrainedTokenizerBase
from torch.utils.data import DataLoader
from sentence_transformers import CrossEncoder


ROOT = Path(__file__).resolve().parents[1]
SOURCE_MODEL = ROOT / ".cache" / "models" / "tinybert-cross-encoder"
OUTPUT_MODEL = ROOT / ".cache" / "models" / "tinybert-wiktextract-wsd"
TRAINING_DATA = ROOT / "data" / "training" / "wiktextract-wsd-v1.jsonl"


@dataclass(frozen=True)
class TrainingPair:
    context: str
    gloss: str
    label: float


def read_training_rows(maximum: int) -> list[dict]:
    rows = [
        json.loads(line)
        for line in TRAINING_DATA.read_text(encoding="utf-8").splitlines()
        if line
    ]
    return rows[:maximum]


def context_input(row: dict) -> str:
    return f"Target word: {row['target']}. Context: {row['context']}"


def gloss_input(row: dict, gloss: str) -> str:
    return f"{row['lemma']} ({row['pos']}): {gloss}"


def training_examples(rows: list[dict], negatives_per_positive: int) -> list[TrainingPair]:
    examples: list[TrainingPair] = []
    for row in rows:
        context = context_input(row)
        examples.append(TrainingPair(
            context=context,
            gloss=gloss_input(row, row["positive_gloss"]),
            label=1.0,
        ))
        negatives = row["negative_glosses"][:negatives_per_positive]
        examples.extend(
            TrainingPair(
                context=context,
                gloss=gloss_input(row, negative),
                label=0.0,
            )
            for negative in negatives
        )
    random.Random(0).shuffle(examples)
    return examples


def collate_pairs(
    pairs: list[TrainingPair],
    tokenizer: PreTrainedTokenizerBase,
    max_length: int,
) -> tuple[dict[str, torch.Tensor], torch.Tensor]:
    encoded = tokenizer(
        [pair.context for pair in pairs],
        [pair.gloss for pair in pairs],
        padding=True,
        truncation=True,
        max_length=max_length,
        return_tensors="pt",
    )
    labels = torch.tensor([pair.label for pair in pairs], dtype=torch.float32)
    return dict(encoded), labels


def learning_rate_multiplier(step: int, warmup_steps: int, total_steps: int) -> float:
    if step < warmup_steps:
        return (step + 1) / warmup_steps
    return max(0.0, (total_steps - step) / max(1, total_steps - warmup_steps))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", type=int, required=True)
    parser.add_argument("--negatives-per-positive", type=int, required=True)
    parser.add_argument("--epochs", type=int, required=True)
    parser.add_argument("--batch-size", type=int, required=True)
    parser.add_argument("--learning-rate", type=float, required=True)
    args = parser.parse_args()
    if args.rows < 1 or args.negatives_per_positive < 1 or args.epochs < 1:
        raise ValueError(
            "rows, negatives-per-positive, and epochs must all be positive"
        )
    if args.batch_size < 1 or args.learning_rate <= 0:
        raise ValueError("batch-size and learning-rate must be positive")
    if OUTPUT_MODEL.exists():
        raise FileExistsError(
            f"Output model already exists; move it before retraining: {OUTPUT_MODEL}"
        )

    rows = read_training_rows(args.rows)
    examples = training_examples(rows, args.negatives_per_positive)
    generator = torch.Generator().manual_seed(0)
    model = CrossEncoder(
        str(SOURCE_MODEL),
        local_files_only=True,
        max_length=256,
    )
    loader = DataLoader(
        examples,
        batch_size=args.batch_size,
        shuffle=True,
        generator=generator,
        collate_fn=partial(
            collate_pairs,
            tokenizer=model.tokenizer,
            max_length=256,
        ),
    )
    steps = math.ceil(len(examples) / args.batch_size) * args.epochs
    warmup_steps = math.ceil(steps * 0.1)
    print(json.dumps({
        "training_rows": len(rows),
        "training_pairs": len(examples),
        "epochs": args.epochs,
        "steps": steps,
        "warmup_steps": warmup_steps,
        "output": str(OUTPUT_MODEL.relative_to(ROOT)),
    }), flush=True)
    network = model.model
    network.train()
    optimizer = torch.optim.AdamW(network.parameters(), lr=args.learning_rate)
    scheduler = torch.optim.lr_scheduler.LambdaLR(
        optimizer,
        lr_lambda=partial(
            learning_rate_multiplier,
            warmup_steps=warmup_steps,
            total_steps=steps,
        ),
    )
    loss_function = torch.nn.BCEWithLogitsLoss()
    completed_steps = 0
    for epoch in range(args.epochs):
        for batch, labels in loader:
            optimizer.zero_grad(set_to_none=True)
            logits = network(**batch).logits.reshape(-1)
            loss = loss_function(logits, labels)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(network.parameters(), 1.0)
            optimizer.step()
            scheduler.step()
            completed_steps += 1
            if completed_steps % 50 == 0 or completed_steps == steps:
                print(json.dumps({
                    "epoch": epoch + 1,
                    "step": completed_steps,
                    "steps": steps,
                    "loss": float(loss.detach()),
                    "learning_rate": scheduler.get_last_lr()[0],
                }), flush=True)
    OUTPUT_MODEL.mkdir(parents=True)
    network.save_pretrained(OUTPUT_MODEL)
    model.tokenizer.save_pretrained(OUTPUT_MODEL)


if __name__ == "__main__":
    main()
