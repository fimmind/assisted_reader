from __future__ import annotations

import argparse
import json
import os
import re
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "WSD_Evaluation_Framework" / "Evaluation_Datasets"
OUT = ROOT / "data" / "processed"
WN_POS = {"NOUN": "n", "VERB": "v", "ADJ": "a", "ADV": "r"}


def sentence_text(sentence: ET.Element) -> str:
    return " ".join((token.text or "").strip() for token in sentence if (token.text or "").strip())


def target_char_start(sentence: ET.Element, instance: ET.Element) -> int:
    tokens = [(token.text or "").strip() for token in sentence if (token.text or "").strip()]
    target = (instance.text or "").strip()
    index = next(index for index, token in enumerate(sentence) if token is instance)
    before = [((token.text or "").strip()) for token in list(sentence)[:index] if (token.text or "").strip()]
    return len(" ".join(before)) + (1 if before else 0)


def gold_by_id(path: Path) -> dict[str, list[str]]:
    values: dict[str, list[str]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) >= 2:
            values[parts[0]] = parts[1:]
    return values


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="ALL", choices=["ALL", "senseval2", "senseval3", "semeval2007", "semeval2013", "semeval2015"])
    args = parser.parse_args()
    os.environ.setdefault("NLTK_DATA", str(ROOT / ".cache" / "nltk"))
    from nltk.corpus import wordnet as wn

    source = RAW / args.dataset
    gold = gold_by_id(source / f"{args.dataset}.gold.key.txt")
    root = ET.parse(source / f"{args.dataset}.data.xml").getroot()
    OUT.mkdir(parents=True, exist_ok=True)
    destination = OUT / f"raganato-{args.dataset.lower()}.jsonl"
    written = 0
    with destination.open("w", encoding="utf-8") as output:
        for sentence in root.iter("sentence"):
            context = sentence_text(sentence)
            for instance in sentence.iter("instance"):
                instance_id = instance.attrib["id"]
                sense_keys = gold.get(instance_id, [])
                if not sense_keys:
                    continue
                lemma = instance.attrib["<lemma"] if "<lemma" in instance.attrib else instance.attrib.get("lemma", "")
                pos = instance.attrib.get("pos", "")
                wn_pos = WN_POS.get(pos)
                if not lemma or not wn_pos:
                    continue
                candidates = list(wn.synsets(lemma, pos=wn_pos))
                if len(candidates) < 2:
                    continue
                gold_synsets = {wn.lemma_from_key(key).synset().name() for key in sense_keys}
                if not gold_synsets.intersection({candidate.name() for candidate in candidates}):
                    continue
                target = (instance.text or "").strip()
                record = {
                    "id": instance_id,
                    "dataset": f"raganato-{args.dataset.lower()}",
                    "context": context,
                    "target": target,
                    "target_start": target_char_start(sentence, instance),
                    "lemma": lemma,
                    "pos": pos.lower(),
                    "candidates": [
                        {"sense_id": candidate.name(), "gloss": candidate.definition(), "frequency": sum(item.count() for item in candidate.lemmas())}
                        for candidate in candidates
                    ],
                    "gold": sorted(gold_synsets),
                }
                output.write(json.dumps(record, ensure_ascii=True) + "\n")
                written += 1
    print(f"wrote {written} examples to {destination}")


if __name__ == "__main__":
    main()
