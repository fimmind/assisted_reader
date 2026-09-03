from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "data" / "processed" / "reader-dev-v1.jsonl"
ALLOWED = {"fits", "plausible", "clearly_wrong"}


def main() -> None:
    errors: list[str] = []
    for line_number, line in enumerate(PATH.read_text(encoding="utf-8").splitlines(), start=1):
        record = json.loads(line)
        required = {"id", "dataset", "context", "target", "lemma", "pos", "candidates"}
        missing = required - record.keys()
        if missing:
            errors.append(f"line {line_number}: missing {sorted(missing)}")
            continue
        if record["dataset"] != "reader-dev-v1" or len(record["candidates"]) < 2:
            errors.append(f"line {line_number}: invalid dataset or fewer than two candidates")
        labels = [candidate.get("relevance") for candidate in record["candidates"]]
        if not set(labels) <= ALLOWED or not any(label in {"fits", "plausible"} for label in labels):
            errors.append(f"line {line_number}: invalid relevance labels")
    if errors:
        raise SystemExit("\n".join(errors))
    print("reader-dev-v1 is valid")


if __name__ == "__main__":
    main()
