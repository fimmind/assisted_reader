"""Bounded-memory progress reporting shared by offline WSD build stages."""

from __future__ import annotations

import time


def report_progress(stage: str, completed: int, total: int, started: float, initial: int) -> None:
    elapsed = time.monotonic() - started
    fraction = completed / total if total else 1.0
    filled = min(24, int(fraction * 24))
    rate = (completed - initial) / elapsed if elapsed > 0 else 0
    remaining = (total - completed) / rate if rate > 0 else 0
    eta = f"{remaining / 60:.1f} min" if rate > 0 else "calculating"
    bar = "#" * filled + "-" * (24 - filled)
    print(f"{stage} [{bar}] {fraction * 100:5.1f}% {completed:,}/{total:,} | elapsed {elapsed / 60:.1f} min | ETA {eta}",
          flush=True)
