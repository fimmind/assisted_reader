"""Package the quantized Ettin model as deployable, cacheable static chunks."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "wsd" / ".cache" / "models" / "ettin-150m-wsd"
MODEL = ROOT / "wsd" / ".cache" / "exports" / "ettin-150m-wsd" / "model-int8.onnx"
DESTINATION = ROOT / "public" / "wsd" / "ettin-150m-wsd"
PART_SIZE = 50_000_000
REVISION = "8751b577199d1bb95b74fa2457da7065d57100ae"


def main() -> None:
    if not MODEL.is_file():
        raise FileNotFoundError(f"Missing exported quantized model: {MODEL}")
    destination = DESTINATION
    destination.mkdir(parents=True, exist_ok=True)
    parts = []
    with MODEL.open("rb") as model_file:
        index = 0
        while chunk := model_file.read(PART_SIZE):
            name = f"model.part{index:02d}"
            (destination / name).write_bytes(chunk)
            parts.append({
                "name": name,
                "size": len(chunk),
                "sha256": hashlib.sha256(chunk).hexdigest(),
            })
            index += 1
    if not parts:
        raise ValueError(f"Exported model is empty: {MODEL}")
    for name in ("tokenizer.json", "tokenizer_config.json", "answer_letters.json"):
        shutil.copyfile(SOURCE / name, destination / name)
    (destination / "manifest.json").write_text(json.dumps({
        "model": "sign/Ettin-150m-WSD",
        "revision": REVISION,
        "license": "Apache-2.0",
        "quantization": "dynamic-uint8",
        "size": MODEL.stat().st_size,
        "parts": parts,
    }, indent=2) + "\n")
    print(f"Packaged {len(parts)} model chunks ({sum(part['size'] for part in parts)} bytes)")


if __name__ == "__main__":
    main()
