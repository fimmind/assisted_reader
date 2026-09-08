from __future__ import annotations

import argparse
import json
import math
import random
from functools import partial
from pathlib import Path

import torch
from sentence_transformers import CrossEncoder
from torch.utils.data import DataLoader
from transformers import PreTrainedTokenizerBase

from train_wiktextract_cross_encoder import context_input, gloss_input, read_training_rows


ROOT = Path(__file__).resolve().parents[1]
SOURCE_MODEL = ROOT / ".cache" / "models" / "tinybert-cross-encoder"
OUTPUT_MODEL = ROOT / ".cache" / "models" / "tinybert-wiktextract-listwise"


def eligible_rows(rows: list[dict], negatives_per_positive: int) -> list[dict]:
    selected = [
        row
        for row in rows
        if len(row["negative_glosses"]) >= negatives_per_positive
    ]
    random.Random(0).shuffle(selected)
    return selected


def collate_rows(
    rows: list[dict],
    tokenizer: PreTrainedTokenizerBase,
    negatives_per_positive: int,
    max_length: int,
) -> tuple[dict[str, torch.Tensor], int]:
    contexts: list[str] = []
    glosses: list[str] = []
    for row in rows:
        candidates = [row["positive_gloss"], *row["negative_glosses"][:negatives_per_positive]]
        context = context_input(row)
        contexts.extend([context] * len(candidates))
        glosses.extend(gloss_input(row, candidate) for candidate in candidates)
    encoded = tokenizer(
        contexts,
        glosses,
        padding=True,
        truncation=True,
        max_length=max_length,
        return_tensors="pt",
    )
    return dict(encoded), negatives_per_positive + 1


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
        raise ValueError("rows, negatives-per-positive, and epochs must be positive")
    if args.batch_size < 1 or args.learning_rate <= 0:
        raise ValueError("batch-size and learning-rate must be positive")
    if OUTPUT_MODEL.exists():
        raise FileExistsError(
            f"Output model already exists; move it before retraining: {OUTPUT_MODEL}"
        )

    rows = eligible_rows(read_training_rows(args.rows), args.negatives_per_positive)
    model = CrossEncoder(
        str(SOURCE_MODEL),
        local_files_only=True,
        max_length=256,
    )
    loader = DataLoader(
        rows,
        batch_size=args.batch_size,
        shuffle=True,
        generator=torch.Generator().manual_seed(0),
        collate_fn=partial(
            collate_rows,
            tokenizer=model.tokenizer,
            negatives_per_positive=args.negatives_per_positive,
            max_length=256,
        ),
    )
    steps = math.ceil(len(rows) / args.batch_size) * args.epochs
    warmup_steps = math.ceil(steps * 0.1)
    print(json.dumps({
        "training_rows": len(rows),
        "candidates_per_row": args.negatives_per_positive + 1,
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
    loss_function = torch.nn.CrossEntropyLoss()
    completed_steps = 0
    for epoch in range(args.epochs):
        for batch, candidate_count in loader:
            optimizer.zero_grad(set_to_none=True)
            logits = network(**batch).logits.reshape(-1, candidate_count)
            labels = torch.zeros(logits.shape[0], dtype=torch.long)
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
