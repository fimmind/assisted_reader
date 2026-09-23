"""Adapter for sign's multiple-choice WordNet WSD checkpoints.

The compact answer decoder and prompt follow the checkpoint's published code:
https://github.com/sign/word-sense-disambiguation/tree/main/wsd
"""

from __future__ import annotations

import json

import torch
from torch import nn
from transformers import AutoTokenizer
from transformers.modeling_outputs import MaskedLMOutput
from transformers.models.modernbert.modeling_modernbert import ModernBertConfig, ModernBertForMaskedLM

from rankers import MODEL_ROOT, Ranker, target_span


class WSDModernBertForMaskedLM(ModernBertForMaskedLM):
    _tied_weights_keys = None

    def __init__(self, config: ModernBertConfig) -> None:
        super().__init__(config)
        self.decoder = nn.Linear(
            config.hidden_size,
            int(config.answer_vocab_size),
            bias=config.decoder_bias,
        )

    def forward(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
        prediction_positions: torch.Tensor,
    ) -> MaskedLMOutput:
        hidden = self.model(input_ids=input_ids, attention_mask=attention_mask)[0]
        batch_indices = torch.arange(hidden.size(0), device=hidden.device)
        answer_states = hidden[batch_indices, prediction_positions]
        logits = self.decoder(self.head(answer_states))
        return MaskedLMOutput(logits=logits)


class EttinWsdRanker(Ranker):
    """Use the checkpoint's answer-letter logits to rank the reader's definitions."""

    def __init__(self, name: str) -> None:
        model_path = MODEL_ROOT / name
        if not (model_path / "model.safetensors").is_file():
            raise FileNotFoundError(f"WSD checkpoint is missing: model={name} path={model_path}")
        self.tokenizer = AutoTokenizer.from_pretrained(str(model_path), local_files_only=True)
        self.letters = json.loads((model_path / "answer_letters.json").read_text(encoding="utf-8"))["letters"]
        if len(self.letters) != 128:
            raise ValueError(f"Expected 128 WSD answer letters: model={name} count={len(self.letters)}")
        self.model = WSDModernBertForMaskedLM.from_pretrained(
            str(model_path),
            dtype=torch.float32,
            local_files_only=True,
        )
        self.model.eval()
        torch.set_num_threads(4)
        self.name = name
        self.model_cache_name = name

    def prompt(self, example: dict) -> str:
        start, end = target_span(example)
        context = example["context"]
        if "*" in example["target"]:
            raise ValueError(f"WSD target contains a marker character: id={example.get('id')}")
        context = context.replace("*", "∗")
        candidates = example["candidates"]
        if len(candidates) > 127:
            raise ValueError(f"Too many WSD candidates: id={example.get('id')} count={len(candidates)}")
        marked = f"{context[:start]}*{context[start:end]}*{context[end:]}"
        options = [
            f"{self.letters[index]}. {candidate['gloss']}"
            for index, candidate in enumerate(candidates)
        ]
        options.append(f"{self.letters[127]}. none of the above")
        return f"{marked}\n" + "\n".join(options) + f"\n[unused0] {self.tokenizer.mask_token}"

    def score_many(self, examples: list[dict]) -> list[list[float]]:
        prompts = [self.prompt(example) for example in examples]
        encoded = self.tokenizer(prompts, add_special_tokens=True, truncation=False)
        ids = encoded["input_ids"]
        max_length = int(self.model.config.max_position_embeddings)
        too_long = [(examples[index].get("id"), len(tokens)) for index, tokens in enumerate(ids) if len(tokens) > max_length]
        if too_long:
            raise ValueError(f"WSD prompts exceed model context length: model={self.name} limit={max_length} examples={too_long}")
        order = sorted(range(len(examples)), key=lambda index: len(ids[index]))
        result: list[list[float] | None] = [None] * len(examples)
        for offset in range(0, len(order), 4):
            indices = order[offset:offset + 4]
            padded = self.tokenizer.pad(
                {"input_ids": [ids[index] for index in indices]},
                padding=True,
                return_tensors="pt",
            )
            input_ids = padded["input_ids"]
            attention_mask = padded["attention_mask"]
            mask_positions = input_ids.eq(self.tokenizer.mask_token_id)
            if not bool(torch.all(mask_positions.sum(dim=1) == 1)):
                raise ValueError(f"WSD prompt must contain one mask token: model={self.name} indices={indices}")
            positions = mask_positions.int().argmax(dim=1)
            with torch.inference_mode():
                logits = self.model(input_ids, attention_mask, positions).logits
            if logits is None or logits.shape != (len(indices), 128):
                raise ValueError(f"Unexpected WSD output: model={self.name} shape={None if logits is None else logits.shape}")
            for batch_index, example_index in enumerate(indices):
                count = len(examples[example_index]["candidates"])
                result[example_index] = logits[batch_index, :count].float().tolist()
        if any(scores is None for scores in result):
            raise RuntimeError(f"WSD scorer left examples without scores: model={self.name}")
        return [scores for scores in result if scores is not None]

    def score(self, example: dict) -> list[float]:
        return self.score_many([example])[0]
