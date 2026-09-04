from __future__ import annotations

import csv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "data" / "reader-dev-v2-review.csv"


def item(fits: str | tuple[str, ...], plausible: str | tuple[str, ...] = (), confidence: str = "high") -> dict:
    return {
        "fits": {fits} if isinstance(fits, str) else set(fits),
        "plausible": {plausible} if isinstance(plausible, str) else set(plausible),
        "confidence": confidence,
    }


DECISIONS = {
    "reader-dev-v2-AiW-1104-28": item("rule.noun.2", "rule.noun.1"),
    "reader-dev-v2-AiW-1572-14": item("rule.noun.1", "rule.noun.2"),
    "reader-dev-v2-AiW-126-16": item("pool.noun.2", ("pool.noun.1", "pool.noun.6")),
    "reader-dev-v2-AiW-175-10": item("pool.noun.2", ("pool.noun.1", "pool.noun.6")),
    "reader-dev-v2-AiW-181-9": item("pool.noun.2", ("pool.noun.1", "pool.noun.6")),
    "reader-dev-v2-hitchhikers_guide-2344-12": item("pool.noun.1", "pool.noun.2"),
    "reader-dev-v2-hitchhikers_guide-2702-4": item("pool.noun.7"),
    "reader-dev-v2-AiW-174-47": item("row.noun.1"),
    "reader-dev-v2-AiW-5-9": item("date.noun.5", ("date.noun.4", "date.noun.6")),
    "reader-dev-v2-AiW-979-5": item("clubs.noun.1"),
    "reader-dev-v2-hitchhikers_guide-1004-12": item("better.verb.1"),
    "reader-dev-v2-hitchhikers_guide-1287-13": item("better.verb.1"),
    "reader-dev-v2-hitchhikers_guide-1034-26": item("crossing.noun.12", ("crossing.noun.3", "crossing.noun.4")),
    "reader-dev-v2-hitchhikers_guide-1511-11": item("crossing.noun.5"),
    "reader-dev-v2-hitchhikers_guide-1051-15": item("lined.adjective.1"),
    "reader-dev-v2-hitchhikers_guide-1205-3": item("lined.adjective.1"),
    "reader-dev-v2-hitchhikers_guide-1117-4": item("ringing.noun.1", "ringing.noun.2"),
    "reader-dev-v2-hitchhikers_guide-1137-29": item("change.verb.1"),
    "reader-dev-v2-hitchhikers_guide-1892-30": item((), "change.verb.3", "low"),
    "reader-dev-v2-hitchhikers_guide-1159-8": item("mouth.noun.1", "mouth.noun.3"),
    "reader-dev-v2-hitchhikers_guide-144-1": item("mouth.noun.1", "mouth.noun.3"),
    "reader-dev-v2-hitchhikers_guide-1169-3": item("interesting.adjective.2", "interesting.adjective.1"),
    "reader-dev-v2-hitchhikers_guide-119-13": item("last.adjective.1"),
    "reader-dev-v2-hitchhikers_guide-29-36": item("last.adjective.1"),
    "reader-dev-v2-hitchhikers_guide-1249-6": item("interest.noun.3", "interest.noun.4"),
    "reader-dev-v2-hitchhikers_guide-127-3": item("lights.noun.1"),
    "reader-dev-v2-hitchhikers_guide-131-10": item("filing.noun.2"),
    "reader-dev-v2-hitchhikers_guide-1356-25": item("points.noun.1"),
    "reader-dev-v2-hitchhikers_guide-1382-6": item("paper.noun.1"),
    "reader-dev-v2-hitchhikers_guide-1788-9": item("paper.noun.1"),
    "reader-dev-v2-hitchhikers_guide-1428-6": item("heads.noun.1"),
    "reader-dev-v2-hitchhikers_guide-15-23": item("better.adjective.1"),
    "reader-dev-v2-hitchhikers_guide-1518-22": item("figure.noun.8", "figure.noun.7"),
    "reader-dev-v2-hitchhikers_guide-1528-20": item("parts.noun.1"),
    "reader-dev-v2-hitchhikers_guide-1762-10": item("parts.noun.1"),
    "reader-dev-v2-hitchhikers_guide-2154-11": item("parts.noun.3", "parts.noun.1"),
    "reader-dev-v2-hitchhikers_guide-1624-8": item("showed.verb.1"),
    "reader-dev-v2-hitchhikers_guide-1800-1": item("showed.verb.1"),
    "reader-dev-v2-hitchhikers_guide-1632-2": item("lit.verb.1"),
    "reader-dev-v2-hitchhikers_guide-1710-7": item("means.noun.2"),
    "reader-dev-v2-hitchhikers_guide-1715-48": item("rocks.noun.1"),
    "reader-dev-v2-hitchhikers_guide-179-29": item("flying.adjective.1", "flying.adjective.7"),
    "reader-dev-v2-hitchhikers_guide-185-6": item("flying.adjective.1", "flying.adjective.7"),
    "reader-dev-v2-hitchhikers_guide-186-4": item("flying.adjective.1", "flying.adjective.7"),
    "reader-dev-v2-hitchhikers_guide-1804-6": item("show.verb.7", "show.verb.5"),
    "reader-dev-v2-hitchhikers_guide-1815-10": item("based.verb.2", "based.verb.1"),
    "reader-dev-v2-hitchhikers_guide-1899-34": item("based.adjective.1"),
    "reader-dev-v2-hitchhikers_guide-1991-19": item("subject.noun.3", "subject.noun.4"),
    "reader-dev-v2-hitchhikers_guide-2158-7": item("subject.noun.3"),
    "reader-dev-v2-hitchhikers_guide-2162-16": item("subject.noun.8"),
    "reader-dev-v2-hitchhikers_guide-2129-23": item("lines.noun.1"),
    "reader-dev-v2-hitchhikers_guide-2325-5": item("stage.noun.1"),
    "reader-dev-v2-hitchhikers_guide-2339-10": item("tables.noun.1"),
    "reader-dev-v2-hitchhikers_guide-2907-19": item("tables.noun.1"),
    "reader-dev-v2-hitchhikers_guide-236-16": item("mining.noun.1"),
    "reader-dev-v2-hitchhikers_guide-2582-2": item("current.adjective.1", "current.adjective.2"),
    "reader-dev-v2-hitchhikers_guide-2818-3": item("motion.noun.1"),
    "reader-dev-v2-hitchhikers_guide-283-18": item("kind.adjective.1", "kind.adjective.2"),
}

for identifier in [
    "reader-dev-v2-AiW-1423-6", "reader-dev-v2-AiW-1425-6", "reader-dev-v2-AiW-1437-20",
    "reader-dev-v2-AiW-1444-12", "reader-dev-v2-AiW-1459-13",
]:
    DECISIONS[identifier] = item("court.noun.11", "court.noun.12")
for identifier in [
    "reader-dev-v2-hitchhikers_guide-1946-6", "reader-dev-v2-hitchhikers_guide-207-3",
    "reader-dev-v2-hitchhikers_guide-2100-3", "reader-dev-v2-hitchhikers_guide-2286-3",
    "reader-dev-v2-hitchhikers_guide-2540-3",
]:
    DECISIONS[identifier] = item("seconds.noun.1")
for identifier in [
    "reader-dev-v2-hitchhikers_guide-234-11", "reader-dev-v2-hitchhikers_guide-235-1",
    "reader-dev-v2-hitchhikers_guide-239-1",
]:
    DECISIONS[identifier] = item(("game.noun.1", "game.noun.3"), "game.noun.5")
for identifier in [
    "reader-dev-v2-hitchhikers_guide-2477-37", "reader-dev-v2-hitchhikers_guide-2480-24",
    "reader-dev-v2-hitchhikers_guide-2701-22",
]:
    DECISIONS[identifier] = item("yards.noun.1")


def main() -> None:
    with PATH.open(newline="", encoding="utf-8") as source:
        rows = list(csv.DictReader(source))
    available = {(row["example_id"], row["sense_id"]) for row in rows}
    for identifier, decision in DECISIONS.items():
        missing = (decision["fits"] | decision["plausible"]) - {sense for example, sense in available if example == identifier}
        if missing:
            raise SystemExit(f"Configured candidate IDs missing for {identifier}: {sorted(missing)}")
    for row in rows:
        decision = DECISIONS.get(row["example_id"])
        if not decision:
            continue
        row["annotation_confidence"] = decision["confidence"]
        if row["relevance"] != "needs_review":
            continue
        if row["sense_id"] in decision["fits"]:
            row["relevance"] = "fits"
        elif row["sense_id"] in decision["plausible"]:
            row["relevance"] = "plausible"
        else:
            row["relevance"] = "clearly_wrong"
        row["reviewer_notes"] = "Codex provisional semantic annotation; retained for stability review."
    with PATH.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(destination, fieldnames=list(rows[0]))
        writer.writeheader(); writer.writerows(rows)
    unresolved = {row["example_id"] for row in rows if row["relevance"] == "needs_review"}
    print(f"applied {len(DECISIONS)} explicit contextual decisions; unresolved non-excluded examples: {len(unresolved)}")


if __name__ == "__main__":
    main()
