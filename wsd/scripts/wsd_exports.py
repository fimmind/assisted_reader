"""Validate completed ONNX exports; interrupted files are never reused."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import TypedDict, cast


class ExportReceipt(TypedDict):
    recipeSha256: str
    files: dict[str, str]


def file_digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


def write_export_receipt(output: Path, receipt_name: str, files: list[str], recipe: Path) -> None:
    receipt: ExportReceipt = {"recipeSha256": file_digest(recipe),
                              "files": {name: file_digest(output / name) for name in files}}
    destination = output / receipt_name
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    temporary.replace(destination)


def export_ready(output: Path, receipt_name: str, files: list[str], recipe: Path) -> bool:
    try:
        payload = json.loads((output / receipt_name).read_text())
        if not isinstance(payload, dict) or not isinstance(payload.get('files'), dict):
            raise ValueError('Invalid export completion receipt.')
        receipt = cast(ExportReceipt, payload)
        if receipt["recipeSha256"] != file_digest(recipe) or set(receipt["files"]) != set(files):
            raise ValueError("Export recipe or file list changed.")
        for name in files:
            if not (output / name).is_file() or (output / name).stat().st_size == 0 or file_digest(output / name) != receipt["files"][name]:
                raise ValueError(f"Export missing or incomplete: file={name}")
    except (FileNotFoundError, json.JSONDecodeError, KeyError, ValueError) as error:
        print(f"WSD export requires generation: {output.name}/{receipt_name}: {error}", flush=True)
        return False
    return True
