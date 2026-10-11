"""Filesystem and real cgroup integration checks for WSD generation."""

from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile
import unittest

from wsd_exports import export_ready, write_export_receipt
from wsd_memory import MIB, MemoryBudget, MemorySafetyError, run_limited_generation


class WebGenerationTest(unittest.TestCase):
    def test_incomplete_exports_are_not_reused(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model = root / "model-int8.onnx"
            recipe = root / "recipe.py"
            recipe.write_text("original recipe")
            model.write_bytes(b"completed output")
            self.assertFalse(export_ready(root, "receipt.json", [model.name], recipe))
            write_export_receipt(root, "receipt.json", [model.name], recipe)
            self.assertTrue(export_ready(root, "receipt.json", [model.name], recipe))
            model.write_bytes(b"interrupted")
            self.assertFalse(export_ready(root, "receipt.json", [model.name], recipe))
            model.write_bytes(b"completed output")
            recipe.write_text("updated recipe")
            self.assertFalse(export_ready(root, "receipt.json", [model.name], recipe))

    @unittest.skipUnless(os.environ.get("WSD_TEST_MEMORY_SCOPE") == "1", "Set WSD_TEST_MEMORY_SCOPE=1 on a host with a user systemd manager.")
    def test_kernel_caps_descendant_memory_without_host_oom(self) -> None:
        root = Path(__file__).resolve().parents[2]
        environment = dict(os.environ)
        budget = MemoryBudget(64 * MIB, 0)
        run_limited_generation([sys.executable, "-c", "from wsd_memory import require_memory_scope; require_memory_scope(); import time; data=bytearray(8*1024*1024); time.sleep(2)"],
                               budget, environment, root)
        workload = "import subprocess, sys; subprocess.run([sys.executable, '-c', 'data=bytearray(128*1024*1024)'])"
        with self.assertRaisesRegex(MemorySafetyError, "Generation scope failed"):
            run_limited_generation([sys.executable, "-c", workload], budget, environment, root)


if __name__ == "__main__":
    unittest.main()
