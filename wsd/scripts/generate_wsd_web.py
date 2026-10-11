"""Run requested WSD build stages inside the supervisor's memory-limited scope."""

from __future__ import annotations

import argparse

from ensure_wsd_web import (
    ROOT, REVISIONS, build_ettin, build_glite, build_sayedshaun, check_package,
    ensure_environment, wordnet_inputs,
)
from wsd_memory import require_memory_scope


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("models", nargs="+", choices=list(REVISIONS))
    arguments = parser.parse_args()
    require_memory_scope()
    ensure_environment()
    source_hash, indices = wordnet_inputs()
    for name in arguments.models:
        directory = ROOT / "public" / "wsd" / name
        directory.mkdir(parents=True, exist_ok=True)
        marker = directory / ".building"
        marker.write_text("WSD generation in progress. Retry pnpm ensure:wsd if interrupted.\n")
        if name == "sayedshaun-wsd":
            build_sayedshaun()
        elif name == "glite-lens":
            build_glite()
        else:
            build_ettin()
        check_package(name, source_hash, indices)
        marker.unlink()


if __name__ == "__main__":
    main()
