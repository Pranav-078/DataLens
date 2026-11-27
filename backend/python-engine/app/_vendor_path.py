"""
Makes the vendored, unmodified Phase 1 profiler package (vendor/datasage_profiler)
importable as `datasage_profiler`, without installing it via pip.

Why vendored rather than pip-installed: Phase 1 was delivered as a standalone
project with its own pyproject.toml, not published to any package index.
Vendoring the exact source (see backend-python/vendor/datasage_profiler —
verified byte-identical to the delivered Phase 1 zip) is how it's reused
without copying/rewriting its logic, per the integration rules for this step.

Any module that needs `import datasage_profiler` must import this module
first (or import app.adapters.phase1_adapter, which does so itself).
"""

import sys
from pathlib import Path

_VENDOR_DIR = Path(__file__).resolve().parent.parent / "vendor"

if str(_VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(_VENDOR_DIR))
