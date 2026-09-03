from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "raw" / "bert-disambiguation-master" / "data"
OUT = ROOT / "data" / "processed" / "coarsewsd-20-test.jsonl"


def load_mappings() -> dict[str, str]:
    mappings: dict[str, str] = {}
    for line in (SOURCE / "wn_mappings.tsv").read_text(encoding="utf-8").splitlines()[1:]:
        word, sense, _, synset, _ = line.split("\t")
        if synset != "UNK":
            mappings[sense] = synset
    return mappings


def main() -> None:
    os.environ.setdefault("NLTK_DATA", str(ROOT / ".cache" / "nltk"))
    from nltk.corpus import wordnet as wn

    mappings = load_mappings()
    base = SOURCE / "CoarseWSD-20"
    OUT.parent.mkdir(parents=True, exist_ok=True)
    total = mapped = 0
    with OUT.open("w", encoding="utf-8") as output:
        for word_dir in sorted(path for path in base.iterdir() if path.is_dir()):
            classes = {int(key): value for key, value in json.loads((word_dir / "classes_map.txt").read_text(encoding="utf-8")).items()}
            candidates = []
            for label, sense in sorted(classes.items()):
                synset_name = mappings.get(sense)
                gloss = wn.synset(synset_name).definition() if synset_name else sense.replace("_", " ")
                candidates.append({"sense_id": sense, "gloss": gloss, "wordnet_synset": synset_name})
            labels = [int(value) for value in (word_dir / "test.gold.txt").read_text(encoding="utf-8").splitlines()]
            sentences = [line.split("\t", 1)[1].strip() for line in (word_dir / "test.data.txt").read_text(encoding="utf-8").splitlines()]
            for index, (context, label) in enumerate(zip(sentences, labels)):
                gold = candidates[label]
                mapped += gold["wordnet_synset"] is not None
                total += 1
                output.write(json.dumps({
                    "id": f"coarsewsd-20-{word_dir.name}-{index}", "dataset": "coarsewsd-20-test",
                    "context": context, "target": word_dir.name, "lemma": word_dir.name, "pos": "noun",
                    "candidates": candidates, "gold": [gold["sense_id"]],
                }, ensure_ascii=True) + "\n")
    print(f"wrote {total} examples to {OUT}; gold labels mapped to WordNet: {mapped}/{total}")


if __name__ == "__main__":
    main()
