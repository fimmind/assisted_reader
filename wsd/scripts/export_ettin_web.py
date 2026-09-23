"""Export the benchmark Ettin WSD checkpoint for browser inference."""

from __future__ import annotations

import argparse
from pathlib import Path

import torch
from onnxruntime.quantization import QuantType, quantize_dynamic

from ettin_wsd import WSDModernBertForMaskedLM


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / ".cache" / "models" / "ettin-150m-wsd"


class AnswerLogits(torch.nn.Module):
    def __init__(self, model: WSDModernBertForMaskedLM) -> None:
        super().__init__()
        self.model = model

    def forward(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
        prediction_positions: torch.Tensor,
    ) -> torch.Tensor:
        return self.model(input_ids, attention_mask, prediction_positions).logits


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not (SOURCE / "model.safetensors").is_file():
        raise FileNotFoundError(f"Missing Ettin checkpoint at {SOURCE}")

    args.output.mkdir(parents=True, exist_ok=True)
    fp32 = args.output / "model-fp32.onnx"
    int8 = args.output / "model-int8.onnx"
    model = WSDModernBertForMaskedLM.from_pretrained(
        SOURCE, dtype=torch.float32, local_files_only=True, attn_implementation="sdpa"
    ).eval()
    wrapper = AnswerLogits(model).eval()
    torch.onnx.export(
        wrapper,
        (
            torch.tensor([[50281, 1, 50282]], dtype=torch.long),
            torch.ones((1, 3), dtype=torch.long),
            torch.tensor([1], dtype=torch.long),
        ),
        fp32,
        input_names=["input_ids", "attention_mask", "prediction_positions"],
        output_names=["logits"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "sequence"},
            "attention_mask": {0: "batch", 1: "sequence"},
            "prediction_positions": {0: "batch"},
            "logits": {0: "batch"},
        },
        opset_version=18,
        do_constant_folding=True,
        dynamo=False,
    )
    quantize_dynamic(fp32, int8, weight_type=QuantType.QUInt8)
    print(f"Exported {int8} ({int8.stat().st_size / 1_000_000:.1f} MB)")


if __name__ == "__main__":
    main()
