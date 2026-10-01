"""Export the released Glite LENS gloss tower for offline vector generation."""

from __future__ import annotations

import argparse
import gc
from pathlib import Path

import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import AutoConfig, AutoModel


ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / ".cache" / "models" / "glite-lens-base"
CHECKPOINT = ROOT / ".cache" / "models" / "glite-lens" / "best_model.ckpt"


class GlossEncoder(torch.nn.Module):
    def __init__(self, encoder: torch.nn.Module) -> None:
        super().__init__()
        self.encoder = encoder

    def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor) -> torch.Tensor:
        return self.encoder(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state[:, 0, :]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not CHECKPOINT.is_file():
        raise FileNotFoundError(f"Missing Glite LENS checkpoint: path={CHECKPOINT}")
    args.output.mkdir(parents=True, exist_ok=True)
    config = AutoConfig.from_pretrained(str(BASE), local_files_only=True)
    encoder = AutoModel.from_config(config)
    payload = torch.load(CHECKPOINT, map_location="cpu", weights_only=True, mmap=True)
    state = payload["model_state_dict"]
    weights = {key.removeprefix("gloss_encoder."): value for key, value in state.items()
               if key.startswith("gloss_encoder.")}
    encoder.load_state_dict(weights, strict=True)
    del payload, state, weights
    gc.collect()
    model = GlossEncoder(encoder.eval()).eval()
    fp32 = args.output / "gloss-fp32.onnx"
    int8 = args.output / "gloss-int8.onnx"
    torch.onnx.export(
        model,
        (torch.tensor([[50281, 258, 50282]], dtype=torch.long), torch.ones((1, 3), dtype=torch.long)),
        fp32,
        input_names=["input_ids", "attention_mask"],
        output_names=["embedding"],
        dynamic_axes={"input_ids": {0: "batch", 1: "sequence"},
                      "attention_mask": {0: "batch", 1: "sequence"},
                      "embedding": {0: "batch"}},
        opset_version=18,
        do_constant_folding=True,
        dynamo=False,
    )
    quantize_dynamic(fp32, int8, weight_type=QuantType.QUInt8)
    print(f"Exported {int8} ({int8.stat().st_size / 1_000_000:.1f} MB)")


if __name__ == "__main__":
    main()
