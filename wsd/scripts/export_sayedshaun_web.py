"""Export SayedShaun's DistilBERT [CLS] encoder for browser inference."""

from __future__ import annotations

import argparse
from pathlib import Path

import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import AutoConfig, AutoModel, AutoTokenizer

from wsd_exports import write_export_receipt
from wsd_memory import require_memory_scope


ROOT = Path(__file__).resolve().parents[1]
MODEL_ROOT = ROOT / ".cache" / "models"
WEIGHTS = MODEL_ROOT / "sayedshaun-wsd" / "cosine" / "step-12000-f1-0.8066.pt"
BASE = MODEL_ROOT / "sayedshaun-distilbert-base"


class ClsEncoder(torch.nn.Module):
    def __init__(self, encoder: torch.nn.Module) -> None:
        super().__init__()
        self.encoder = encoder

    def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor) -> torch.Tensor:
        return self.encoder(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state[:, 0, :]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    require_memory_scope()
    if not WEIGHTS.is_file() or not (BASE / "config.json").is_file():
        raise FileNotFoundError(f"Missing SayedShaun checkpoint or base config: weights={WEIGHTS} base={BASE}")
    args.output.mkdir(parents=True, exist_ok=True)
    tokenizer = AutoTokenizer.from_pretrained(str(BASE), local_files_only=True)
    tokenizer.add_special_tokens({"additional_special_tokens": ["<classify>", "</classify>"]})
    tokenizer.save_pretrained(args.output)
    config = AutoConfig.from_pretrained(str(BASE), local_files_only=True)
    config.vocab_size = len(tokenizer)
    encoder = AutoModel.from_config(config)
    state = torch.load(WEIGHTS, map_location="cpu", weights_only=True)
    weights = {key.removeprefix("encoder."): value for key, value in state.items()}
    if len(weights) != len(state):
        raise ValueError(f"Unexpected SayedShaun checkpoint keys: path={WEIGHTS}")
    encoder.load_state_dict(weights, strict=True)
    model = ClsEncoder(encoder.eval()).eval()
    fp32 = args.output / "model-fp32.onnx"
    int8 = args.output / "model-int8.onnx"
    torch.onnx.export(
        model,
        (
            torch.tensor([[101, 1043, 102]], dtype=torch.long),
            torch.ones((1, 3), dtype=torch.long),
        ),
        fp32,
        input_names=["input_ids", "attention_mask"],
        output_names=["embedding"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "sequence"},
            "attention_mask": {0: "batch", 1: "sequence"},
            "embedding": {0: "batch"},
        },
        opset_version=18,
        do_constant_folding=True,
        dynamo=False,
    )
    quantize_dynamic(fp32, int8, weight_type=QuantType.QUInt8)
    write_export_receipt(args.output, "model-export.json", ["model-int8.onnx","tokenizer.json","tokenizer_config.json"], Path(__file__))
    print(f"Exported {int8} ({int8.stat().st_size / 1_000_000:.1f} MB)")


if __name__ == "__main__":
    main()
