"""
Deterministic, reproducible relationship inference and orphan detection
across the tables of one dataset version.

This module is intentionally independent of Phase 1's detector logic — it
only READS Phase 1's already-computed per-column statistics
(datasage_profiler.models.ColumnProfile, produced by DataProfiler.profile())
and the raw DataFrames themselves. Nothing in vendor/datasage_profiler is
imported for modification; `from app import _vendor_path` plus a read-only
import of its models/config is the same pattern app/adapters/phase1_adapter.py
already uses.

No LLM is used anywhere in this module. Every number here is either read
directly from Phase 1's output or computed with plain pandas/stdlib
operations, which is what "deterministic" means in this design: the same
input tables always produce byte-identical output.

────────────────────────────────────────────────────────────────────────
ALGORITHM (Phase 2 design, reusing the exact weights specified in the
approved architecture review — see docs/phase2.md for the full writeup)
────────────────────────────────────────────────────────────────────────

Stage 0 — parent candidates: a column qualifies as a PARENT (the "one"
  side of a relationship) only if it looks like a real key:
      uniqueness_ratio  >= MIN_PARENT_UNIQUENESS
      null_percentage   <= MAX_PARENT_NULL_PCT
      distinct_count    >= MIN_PARENT_DISTINCT_COUNT
      inferred_type     in {"integer", "string"}   (never float/date/boolean)

Stage 1 — hard gates per (parent, child) candidate pair, checked BEFORE any
  expensive value-level work and before computing a confidence score at
  all. A pair failing any of these is not scored, not returned, and never
  becomes a "relationship" purely because two column names look similar:
      no self-relationships (parent_table != child_table)
      types must be compatible (see type_exactness)
      child.distinct_count <= parent.distinct_count * MAX_CHILD_TO_PARENT_DISTINCT_RATIO
      child.null_percentage <= MAX_CHILD_NULL_PCT
      containment (see Stage 2) >= MIN_CONTAINMENT

Stage 2 — containment: vectorized, set/hash-based, O(n) per column pair —
  never a row-by-row or O(n^2) comparison. This is also where orphan
  detection happens, as a direct byproduct of the same containment check
  (the schema stores orphan stats ON the relationship row, not separately).

Stage 3 — name similarity: normalized-token comparison, falling back to
  difflib.SequenceMatcher (Python stdlib — no new dependency) rather than
  a third-party fuzzy-matching library.

Stage 4 — confidence: a fixed weighted sum of four signals (see
  CONFIDENCE_WEIGHT_* below), banded into high/medium/low, with a floor
  below which a candidate is dropped entirely.

Stage 5 — disambiguation: if the same child column clears the bar against
  more than one parent, only the highest-confidence parent is kept (ties
  broken deterministically by parent table/column name) — the runner-up(s)
  are recorded in evidence, not silently dropped from the record entirely.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any, Optional
import re

import pandas as pd

from app import _vendor_path  # noqa: F401  (must run before importing datasage_profiler)
from datasage_profiler.config import ProfilerConfig
from datasage_profiler.models import ColumnProfile, DatasetProfile
from datasage_profiler.utils import non_missing_values

# ──────────────────────────────────────────────────────────────────────
# Named thresholds — Phase 2 design constants. Deliberately NOT scattered
# as magic numbers through the code below; every gate references one of
# these. None of these are claimed to be universally "correct" — they are
# this project's documented starting point (see docs/phase2.md), tunable
# in one place if real-world data ever shows they need adjusting.
# ──────────────────────────────────────────────────────────────────────

# Stage 0 — what makes a column a plausible parent/primary key.
MIN_PARENT_UNIQUENESS = 0.99
MAX_PARENT_NULL_PCT = 0.10
MIN_PARENT_DISTINCT_COUNT = 20
PARENT_CANDIDATE_TYPES = frozenset({"integer", "string"})

# Stage 1 — hard gates applied before any relationship can be scored.
MAX_CHILD_TO_PARENT_DISTINCT_RATIO = 1.05
MAX_CHILD_NULL_PCT = 60.0
MIN_CONTAINMENT = 0.50

# Stage 4 — confidence weights. These four MUST sum to 1.0; see
# test_relationships_inference.py's test asserting exactly that, so a
# future edit here can't silently change the scale of the output.
CONFIDENCE_WEIGHT_CONTAINMENT = 0.55
CONFIDENCE_WEIGHT_NAME_SIMILARITY = 0.20
CONFIDENCE_WEIGHT_TYPE_EXACTNESS = 0.15
CONFIDENCE_WEIGHT_NULL_RATE = 0.10

# Confidence is dropped below this floor; bands apply only above it.
MIN_CONFIDENCE_TO_REPORT = 0.50
CONFIDENCE_BAND_HIGH_MIN = 0.85
CONFIDENCE_BAND_MEDIUM_MIN = 0.65

# Orphan examples are capped so a relationship row never carries anything
# close to the full source column — see the module docstring and
# docs/phase2.md's "what is NOT stored" section.
MAX_ORPHAN_EXAMPLES = 5

_MISSING_TOKENS = ProfilerConfig().missing_tokens


@dataclass(frozen=True)
class RelationshipCandidate:
    parent_table: str
    parent_column: str
    child_table: str
    child_column: str
    confidence: float
    confidence_band: str  # "high" | "medium" | "low"
    value_overlap: float  # containment ratio, 0.0-1.0
    orphan_count: int
    orphan_percentage: float
    orphan_examples: list[str]
    evidence: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class _ContainmentResult:
    containment: float
    child_checked_count: int
    orphan_count: int
    orphan_percentage: float
    orphan_examples: list[str]


def _normalize_token(column_name: str) -> str:
    """"Customer_ID" -> "customer"; "customerId" -> "customerid" (no
    camelCase splitting attempted — kept simple and documented as such)."""
    token = re.sub(r"[^a-z0-9]+", "_", column_name.lower()).strip("_")
    stripped = re.sub(r"_?id$", "", token)
    return stripped or token  # never return an empty string


def name_similarity(parent_table: str, parent_column: str, child_table: str, child_column: str) -> float:
    """Returns a 0.0-1.0 score. Pure, deterministic, no I/O."""
    parent_norm = _normalize_token(parent_column)
    child_norm = _normalize_token(child_column)

    if parent_norm == child_norm:
        return 1.0

    parent_table_singular = parent_table.rstrip("sS")
    if child_norm == parent_table_singular.lower():
        return 0.9

    if len(parent_norm) >= 4 and (parent_norm in child_norm or child_norm in parent_norm):
        return 0.7

    return SequenceMatcher(None, parent_norm, child_norm).ratio()


def type_exactness(parent_type: str, child_type: str) -> float:
    """1.0 for an exact inferred-type match, 0.6 for the specific
    int<->string case (a digit-string child column referencing an integer
    parent key, or vice versa — common when one CSV quotes IDs and
    another doesn't), 0.0 otherwise. 0.0 is also what makes two columns
    "type incompatible" for Stage 1's hard gate (see _types_compatible)."""
    if parent_type == child_type:
        return 1.0
    if {parent_type, child_type} == {"integer", "string"}:
        return 0.6
    return 0.0


def _types_compatible(parent_type: str, child_type: str) -> bool:
    return type_exactness(parent_type, child_type) > 0.0


def _confidence_band(confidence: float) -> str:
    if confidence >= CONFIDENCE_BAND_HIGH_MIN:
        return "high"
    if confidence >= CONFIDENCE_BAND_MEDIUM_MIN:
        return "medium"
    return "low"


def _is_parent_candidate(profile: ColumnProfile) -> bool:
    if profile.non_null_count == 0:
        return False
    if profile.inferred_type not in PARENT_CANDIDATE_TYPES:
        return False
    if profile.null_percentage > MAX_PARENT_NULL_PCT:
        return False
    uniqueness_ratio = profile.unique_count / profile.non_null_count
    if uniqueness_ratio < MIN_PARENT_UNIQUENESS:
        return False
    if profile.unique_count < MIN_PARENT_DISTINCT_COUNT:
        return False
    return True


def _compute_containment(parent_series: pd.Series, child_series: pd.Series) -> _ContainmentResult:
    """Vectorized, set/hash-based — O(n), never a row-by-row or O(n^2)
    comparison. Null/empty values on the child side are excluded from the
    denominator entirely: an unset foreign key is not a "found" value and
    is not an "orphan" either, it's simply not checkable."""
    parent_values = set(non_missing_values(parent_series, _MISSING_TOKENS))
    child_checked = non_missing_values(child_series, _MISSING_TOKENS)

    if len(child_checked) == 0:
        return _ContainmentResult(0.0, 0, 0, 0.0, [])

    child_checked_series = pd.Series(child_checked)
    is_found = child_checked_series.isin(parent_values)
    orphan_values = child_checked_series[~is_found]

    orphan_count = int(len(orphan_values))
    containment = 1.0 - (orphan_count / len(child_checked))
    orphan_percentage = round(100.0 * orphan_count / len(child_checked), 3)
    # Sorted (not insertion-order) so the examples list is itself
    # deterministic across runs regardless of pandas' internal ordering.
    orphan_examples = sorted(set(orphan_values.tolist()))[:MAX_ORPHAN_EXAMPLES]

    return _ContainmentResult(
        containment=round(containment, 6),
        child_checked_count=len(child_checked),
        orphan_count=orphan_count,
        orphan_percentage=orphan_percentage,
        orphan_examples=orphan_examples,
    )


def _column_profiles_by_table(table_profiles: list[DatasetProfile]) -> dict[str, dict[str, ColumnProfile]]:
    return {dp.table: {cp.name: cp for cp in dp.columns} for dp in table_profiles}


def infer_relationships(
    tables: dict[str, "pd.DataFrame"],
    table_profiles: list[DatasetProfile],
) -> list[RelationshipCandidate]:
    """
    The single public entry point. Takes the same `tables` mapping already
    loaded for Phase 1 profiling plus Phase 1's own already-computed
    per-column profiles (no re-scanning of data Phase 1 already
    characterized), and returns one RelationshipCandidate per accepted
    (parent, child) pair — at most one parent per distinct child column,
    per Stage 5's disambiguation policy.

    Never raises for a single bad candidate pair: any unexpected error
    evaluating one (parent, child) pair is caught and that pair is simply
    skipped, so one malformed column can never take down the whole
    inference pass (or, one level up, the whole API request).
    """
    profiles_by_table = _column_profiles_by_table(table_profiles)

    parent_candidates: list[tuple[str, str, ColumnProfile]] = []
    for table_name, columns in profiles_by_table.items():
        for column_name, profile in columns.items():
            try:
                if _is_parent_candidate(profile):
                    parent_candidates.append((table_name, column_name, profile))
            except Exception:
                continue  # a malformed profile is treated as "not a parent candidate", not a crash

    # Best candidate seen so far per (child_table, child_column), so Stage 5's
    # disambiguation can run in a single pass without a second full loop.
    best_by_child: dict[tuple[str, str], RelationshipCandidate] = {}
    runners_up: dict[tuple[str, str], list[dict[str, Any]]] = {}

    for parent_table, parent_column, parent_profile in parent_candidates:
        for child_table, child_columns in profiles_by_table.items():
            if child_table == parent_table:
                continue
            for child_column, child_profile in child_columns.items():
                try:
                    candidate = _evaluate_pair(
                        tables, parent_table, parent_column, parent_profile,
                        child_table, child_column, child_profile,
                    )
                except Exception:
                    continue  # one bad pair never aborts the whole inference pass

                if candidate is None:
                    continue

                key = (child_table, child_column)
                existing = best_by_child.get(key)
                if existing is None or _is_better_candidate(candidate, existing):
                    if existing is not None:
                        runners_up.setdefault(key, []).append(_runner_up_summary(existing))
                    best_by_child[key] = candidate
                else:
                    runners_up.setdefault(key, []).append(_runner_up_summary(candidate))

    results: list[RelationshipCandidate] = []
    for key, candidate in best_by_child.items():
        extra_parents = runners_up.get(key, [])
        if extra_parents:
            candidate.evidence["other_candidate_parents"] = sorted(
                extra_parents, key=lambda p: (-p["confidence"], p["parent_table"], p["parent_column"])
            )
        results.append(candidate)

    # Deterministic output order, independent of dict iteration order.
    results.sort(key=lambda r: (r.child_table, r.child_column, r.parent_table, r.parent_column))
    return results


def _is_better_candidate(a: RelationshipCandidate, b: RelationshipCandidate) -> bool:
    """Deterministic tie-break: higher confidence wins; exact ties broken
    by parent table/column name so the result never depends on dict/loop
    iteration order."""
    if a.confidence != b.confidence:
        return a.confidence > b.confidence
    return (a.parent_table, a.parent_column) < (b.parent_table, b.parent_column)


def _runner_up_summary(candidate: RelationshipCandidate) -> dict[str, Any]:
    return {
        "parent_table": candidate.parent_table,
        "parent_column": candidate.parent_column,
        "confidence": candidate.confidence,
    }


def _evaluate_pair(
    tables: dict[str, "pd.DataFrame"],
    parent_table: str,
    parent_column: str,
    parent_profile: ColumnProfile,
    child_table: str,
    child_column: str,
    child_profile: ColumnProfile,
) -> Optional[RelationshipCandidate]:
    # Stage 1 — cheap hard gates first, before touching any actual values.
    if not _types_compatible(parent_profile.inferred_type, child_profile.inferred_type):
        return None
    if child_profile.unique_count > parent_profile.unique_count * MAX_CHILD_TO_PARENT_DISTINCT_RATIO:
        return None
    if child_profile.null_percentage > MAX_CHILD_NULL_PCT:
        return None

    parent_series = tables[parent_table][parent_column]
    child_series = tables[child_table][child_column]
    containment_result = _compute_containment(parent_series, child_series)

    if containment_result.containment < MIN_CONTAINMENT:
        return None

    name_sim = name_similarity(parent_table, parent_column, child_table, child_column)
    type_score = type_exactness(parent_profile.inferred_type, child_profile.inferred_type)
    null_rate_score = 1.0 - (child_profile.null_percentage / 100.0)

    confidence = round(
        CONFIDENCE_WEIGHT_CONTAINMENT * containment_result.containment
        + CONFIDENCE_WEIGHT_NAME_SIMILARITY * name_sim
        + CONFIDENCE_WEIGHT_TYPE_EXACTNESS * type_score
        + CONFIDENCE_WEIGHT_NULL_RATE * null_rate_score,
        6,
    )

    if confidence < MIN_CONFIDENCE_TO_REPORT:
        return None

    evidence = {
        "parent_uniqueness": round(parent_profile.unique_count / parent_profile.non_null_count, 6),
        "parent_distinct_count": parent_profile.unique_count,
        "parent_null_percentage": parent_profile.null_percentage,
        "child_distinct_count": child_profile.unique_count,
        "child_null_percentage": child_profile.null_percentage,
        "child_checked_count": containment_result.child_checked_count,
        "parent_type": parent_profile.inferred_type,
        "child_type": child_profile.inferred_type,
        "score_terms": {
            "containment": containment_result.containment,
            "containment_weighted": round(CONFIDENCE_WEIGHT_CONTAINMENT * containment_result.containment, 6),
            "name_similarity": round(name_sim, 6),
            "name_similarity_weighted": round(CONFIDENCE_WEIGHT_NAME_SIMILARITY * name_sim, 6),
            "type_exactness": type_score,
            "type_exactness_weighted": round(CONFIDENCE_WEIGHT_TYPE_EXACTNESS * type_score, 6),
            "null_rate_score": round(null_rate_score, 6),
            "null_rate_weighted": round(CONFIDENCE_WEIGHT_NULL_RATE * null_rate_score, 6),
        },
        "weights_used": {
            "containment": CONFIDENCE_WEIGHT_CONTAINMENT,
            "name_similarity": CONFIDENCE_WEIGHT_NAME_SIMILARITY,
            "type_exactness": CONFIDENCE_WEIGHT_TYPE_EXACTNESS,
            "null_rate": CONFIDENCE_WEIGHT_NULL_RATE,
        },
    }

    return RelationshipCandidate(
        parent_table=parent_table,
        parent_column=parent_column,
        child_table=child_table,
        child_column=child_column,
        confidence=confidence,
        confidence_band=_confidence_band(confidence),
        value_overlap=containment_result.containment,
        orphan_count=containment_result.orphan_count,
        orphan_percentage=containment_result.orphan_percentage,
        orphan_examples=containment_result.orphan_examples,
        evidence=evidence,
    )
