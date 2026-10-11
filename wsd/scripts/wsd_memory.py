"""Enforce a shared OS memory cap for every WSD generation subprocess.

Generation requires Linux cgroup v2 and a user systemd manager. There is no
unbounded fallback: unsupported hosts must generate assets on a supported host.
The kernel accounts the whole process tree and file cache, disables swap for
the job, and kills the scope on OOM. A reserve guard stops work if other
applications consume the reserved system memory.
"""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
from typing import NamedTuple
from uuid import uuid4


MIB = 1024 * 1024
GIB = 1024 * MIB


class MemorySafetyError(RuntimeError):
    """Generation cannot run within an enforceable safe memory budget."""


class MemoryBudget(NamedTuple):
    maximum: int
    reserve: int


def available_memory() -> int:
    fields = {name: int(value.split()[0]) * 1024
              for name, value in (line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())}
    available = fields["MemAvailable"]
    group = next(line.removeprefix("0::") for line in Path("/proc/self/cgroup").read_text().splitlines()
                 if line.startswith("0::"))
    root = Path("/sys/fs/cgroup")
    directory = root / group.lstrip("/")
    for parent in (directory, *directory.parents):
        if parent == root.parent:
            break
        maximum = parent / "memory.max"
        if maximum.is_file() and maximum.read_text().strip() != "max":
            remaining = int(maximum.read_text()) - int((parent / "memory.current").read_text())
            available = min(available, max(0, remaining))
    return available


def generation_budget() -> MemoryBudget:
    if not Path("/sys/fs/cgroup/cgroup.controllers").is_file() or shutil.which("systemd-run") is None:
        raise MemorySafetyError("WSD generation needs Linux cgroup v2 and systemd-run --user to enforce its RAM limit. Generate on a supported host; unsafe unbounded generation is disabled.")
    requested = os.environ.get("WSD_MAX_MEMORY_MIB", "4096")
    if not requested.isdigit() or int(requested) < 2048:
        raise MemorySafetyError("WSD_MAX_MEMORY_MIB must be an integer of at least 2048. It is an upper bound, not permission to consume reserved RAM.")
    available = available_memory()
    reserve = 2 * GIB
    maximum = min(int(requested) * MIB, available // 2, available - reserve)
    maximum = (maximum // MIB) * MIB
    if maximum < 2 * GIB:
        raise MemorySafetyError(f"Not enough free RAM for safe WSD generation: available={available // MIB} MiB. At least 4096 MiB must be available; close other applications and retry pnpm ensure:wsd.")
    return MemoryBudget(maximum, reserve)


def require_memory_scope() -> None:
    """Fail before model work if the supervisor's kernel limits are absent."""
    expected = os.environ.get('WSD_MEMORY_LIMIT_BYTES', '')
    if not expected.isdigit():
        raise MemorySafetyError('Run pnpm ensure:wsd; direct generation without the RAM supervisor is disabled.')
    try:
        group = next(line.removeprefix('0::') for line in Path('/proc/self/cgroup').read_text().splitlines()
                     if line.startswith('0::'))
        directory = Path('/sys/fs/cgroup') / group.lstrip('/')
        if (not directory.name.startswith('reader-wsd-')
                or (directory / 'memory.max').read_text().strip() != expected
                or (directory / 'memory.swap.max').read_text().strip() != '0'
                or (directory / 'memory.oom.group').read_text().strip() != '1'):
            raise MemorySafetyError('The generation process has no verified RAM/swap/OOM-group limits. Retry pnpm ensure:wsd on a host with a working user systemd manager.')
    except (FileNotFoundError, StopIteration) as error:
        raise MemorySafetyError('The OS memory controller is unavailable; generation was not started.') from error


def stop_scope(unit: str, process: subprocess.Popen[bytes]) -> None:
    subprocess.run(["systemctl", "--user", "kill", "--kill-whom=all", "--signal=SIGTERM", unit],
                   check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if process.poll() is not None:
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        subprocess.run(["systemctl", "--user", "kill", "--kill-whom=all", "--signal=SIGKILL", unit],
                       check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def run_limited_generation(arguments: list[str], budget: MemoryBudget, environment: dict[str, str], root: Path) -> None:
    unit = f"reader-wsd-{uuid4().hex}.scope"
    command = ["systemd-run", "--user", "--scope", "--quiet", f"--unit={unit}",
               f"--property=MemoryMax={budget.maximum}", f"--property=MemoryHigh={budget.maximum * 9 // 10}",
               "--property=MemorySwapMax=0", "--property=OOMPolicy=kill", *arguments]
    print(f"WSD generation RAM cap: {budget.maximum // MIB} MiB; system reserve: {budget.reserve // MIB} MiB; swap disabled.", flush=True)
    started = time.monotonic()
    peak = 0
    last_log = started
    bounded_environment = {**environment, 'WSD_MEMORY_LIMIT_BYTES': str(budget.maximum)}
    process = subprocess.Popen(command, cwd=root, env=bounded_environment, start_new_session=True)
    try:
        while process.poll() is None:
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
            if process.poll() is not None:
                break
            if available_memory() < budget.reserve:
                raise MemorySafetyError("WSD generation stopped to preserve reserved system RAM. Close other applications and retry; embedding checkpoints will resume completed work.")
            try:
                group = next(line.removeprefix("0::") for line in Path(f"/proc/{process.pid}/cgroup").read_text().splitlines()
                             if line.startswith("0::"))
                directory = Path("/sys/fs/cgroup") / group.lstrip("/")
                if directory.name == unit:
                    if int((directory / "memory.max").read_text()) != budget.maximum or (directory / "memory.swap.max").read_text().strip() != "0":
                        raise MemorySafetyError("The OS did not apply the requested WSD RAM and swap limits.")
                    current = int((directory / "memory.current").read_text())
                    peak = max(peak, int((directory / "memory.peak").read_text()))
                    if time.monotonic() - last_log >= 30:
                        print(f"WSD memory: {current // MIB}/{budget.maximum // MIB} MiB; peak {peak // MIB} MiB.", flush=True)
                        last_log = time.monotonic()
            except FileNotFoundError:
                # A finished scope may disappear before its last memory sample.
                if process.poll() is None:
                    continue
        if process.returncode != 0:
            raise MemorySafetyError(f"Generation scope failed: exit={process.returncode}, RAM cap={budget.maximum // MIB} MiB. An OOM or unavailable user systemd manager stops generation. Review the stage error above and retry pnpm ensure:wsd.")
        memory_summary = f"sampled cgroup peak {peak // MIB} MiB" if peak else "job finished before its first memory sample"
        print(f"WSD generation finished in {time.monotonic() - started:.1f}s; {memory_summary}.", flush=True)
    finally:
        stop_scope(unit, process)
