from __future__ import annotations

import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATASET = "reader-filter-dev-v1"
ALLOWED_CONFIDENCE = {"high", "medium", "low"}


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def runtime_sense_ids(example: dict) -> set[str]:
    target_pos = example.get("pos")
    matching = {
        candidate["sense_id"]
        for candidate in example["candidates"]
        if candidate.get("part_of_speech") == target_pos
    }
    return matching or {candidate["sense_id"] for candidate in example["candidates"]}


def annotate_example(example: dict, annotation: dict) -> dict:
    fits = set(annotation.get("fits", []))
    plausible = set(annotation.get("plausible", []))
    confidence = annotation.get("confidence")
    visible = runtime_sense_ids(example)
    selected = fits | plausible
    if not fits:
        raise ValueError(f"Annotation must include at least one fit: {example['id']}")
    if fits & plausible:
        raise ValueError(f"Fits and plausible overlap: {example['id']} / {sorted(fits & plausible)}")
    if not selected <= visible:
        raise ValueError(
            f"Annotation references non-runtime senses: {example['id']} / {sorted(selected - visible)}"
        )
    if confidence not in ALLOWED_CONFIDENCE:
        raise ValueError(f"Invalid annotation confidence: {example['id']} / {confidence!r}")

    candidates = [
        {
            **candidate,
            "relevance": (
                "fits"
                if candidate["sense_id"] in fits
                else "plausible"
                if candidate["sense_id"] in plausible
                else "clearly_wrong"
            ),
        }
        for candidate in example["candidates"]
    ]
    return {
        **example,
        "dataset": example["dataset"],
        "candidates": candidates,
        "annotation_confidence": confidence,
        "annotation_method": "Codex provisional review before model scoring",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", choices=(DATASET, "reader-wordnet-filter-pilot"), default=DATASET)
    args = parser.parse_args()
    dataset: str = args.dataset
    draft_path = ROOT / "data" / f"{dataset}-draft.jsonl"
    annotation_path = ROOT / "data" / f"{dataset}-annotations.jsonl"
    output_path = ROOT / "data" / "processed" / f"{dataset}.jsonl"
    exclusions_path = ROOT / "data" / f"{dataset}-exclusions.json"
    draft = read_jsonl(draft_path)
    annotation_rows = read_jsonl(annotation_path)
    annotations = {row["id"]: row for row in annotation_rows}
    if len(annotations) != len(annotation_rows):
        raise ValueError("Duplicate IDs in filter annotations")
    draft_ids = {example["id"] for example in draft}
    annotation_ids = set(annotations)
    missing = draft_ids - annotation_ids
    if missing:
        raise ValueError(
            f"Annotations are missing draft IDs: {sorted(missing)}"
        )
    unexpected = annotation_ids - draft_ids
    if unexpected:
        raise ValueError(
            f"Annotations contain unexpected IDs: {sorted(unexpected)}"
        )

    exclusions = {
        identifier: annotation["exclude_reason"]
        for identifier, annotation in annotations.items()
        if identifier in draft_ids and "exclude_reason" in annotation
    }
    processed = [
        annotate_example(example, annotations[example["id"]])
        for example in draft
        if example["id"] not in exclusions
    ]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        "".join(json.dumps(example, ensure_ascii=True) + "\n" for example in processed),
        encoding="utf-8",
    )
    exclusions_path.write_text(
        json.dumps(exclusions, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"wrote {len(processed)} examples to {output_path}; "
        f"documented {len(exclusions)} exclusions in {exclusions_path}"
    )


if __name__ == "__main__":
    main()
