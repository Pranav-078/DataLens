"""
The detector registry. Empty in Phase 0 — this is correct and expected,
not a placeholder to feel bad about. No real detectors exist until Phase 1.

A Phase 1 detector module registers itself by appending a callable here
matching the DetectorFn signature: it receives a table name and a pandas
DataFrame (the corrupted table's contents) and returns an iterable of
Finding-shaped dicts or Finding instances (see detector_contract.py).

detector_eval.py imports DETECTOR_REGISTRY and iterates it — it has no
knowledge of how many detectors exist or what they check. Adding a Phase 1
detector means adding one line here; nothing else in the evaluation harness
changes.
"""

from __future__ import annotations

from typing import Any, Callable, Iterable

import pandas as pd

DetectorFn = Callable[[str, "pd.DataFrame"], Iterable[Any]]

DETECTOR_REGISTRY: list[DetectorFn] = []


def register(fn: DetectorFn) -> DetectorFn:
    """Decorator a Phase 1 detector module uses to register itself, e.g.:

        from evaluation.registry import register

        @register
        def detect_missing_values(table_name, df):
            ...
    """
    DETECTOR_REGISTRY.append(fn)
    return fn
