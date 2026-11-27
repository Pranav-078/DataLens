"""
The real profiling endpoint, built on the vendored Phase 1 profiler, the
Phase 0 adapter, and (as of Phase 2 Slice B) relationship inference.

Deliberately a NEW route (/internal/profile/tables), not a replacement of
the existing /internal/profile stub in profile_stub.py. That stub's exact
request/response shape is what backend-node's profilerClient.ts and its
passing test suite currently depend on; changing it in place would be a
Node-facing change smuggled into a step that is explicitly Python-only.

This endpoint remains fully stateless: it has no database connection and
makes no PostgreSQL writes. It loads the CSV content it's given exactly
once, runs Phase 1 profiling and Phase 2 relationship inference against
that single in-memory load, and returns structured JSON — persistence is
entirely Node's responsibility (Phase 2 Slice C).
"""

from __future__ import annotations

import io
from time import perf_counter
from typing import Literal, Optional

import pandas as pd
from fastapi import APIRouter
from pydantic import BaseModel, Field

from app import _vendor_path  # noqa: F401  (must run before importing datasage_profiler)
from datasage_profiler.engine import DataProfiler

from app.adapters.phase1_adapter import aggregate_profile_result
from app.relationships.inference import infer_relationships
from app.logging_config import logger

router = APIRouter()


class TablePayload(BaseModel):
    tableName: str
    csvContent: str


class ProfileTablesRequest(BaseModel):
    tables: list[TablePayload]
    profileMode: Literal["fast", "full"] = "full"
    sampleSizePerTable: int = Field(default=20_000, ge=1_000, le=50_000)


class FindingPayload(BaseModel):
    issue_type: str
    dimension: str
    table: str
    row_uid: str
    column: Optional[str]
    severity: str
    evidence: dict


class AggregatedIssuePayload(BaseModel):
    tableName: str
    columnName: Optional[str]
    issueType: str
    dimension: str
    severity: str
    title: str
    description: str
    affectedRows: int
    totalRows: int
    affectedPercentage: float
    examples: list[str]
    evidence: dict
    fingerprint: str
    estimated: bool = False


class ColumnProfileSummary(BaseModel):
    """Mirrors Phase 1's ColumnProfile fields exactly (datasage_profiler.models)
    — this is Phase 1's own already-computed output, not new derivation,
    other than uniquenessRatio which is a simple ratio of two of its fields."""

    columnName: str
    inferredType: str
    nullCount: int
    nullPercentage: float
    distinctCount: int
    uniquenessRatio: Optional[float]  # None when non_null_count is 0 — avoids a divide-by-zero


class TableProfileSummary(BaseModel):
    tableName: str
    rowCount: int
    profiledRowCount: int
    columnCount: int
    columns: list[ColumnProfileSummary]


class RelationshipPayload(BaseModel):
    """Field names and semantics match Prisma's InferredRelationship model
    (backend-node/prisma/schema.prisma) directly, so Node's eventual
    persistence step (Slice C) is a straight field-for-field mapping, not
    a translation. `status` is always "inferred" here — Python only ever
    proposes a relationship; a human or a later Node-side action is what
    would ever move it to "confirmed"/"rejected", never this endpoint."""

    parent_table: str
    parent_column: str
    child_table: str
    child_column: str
    confidence: float
    confidence_band: str
    status: str
    value_overlap: float
    orphan_count: int
    orphan_percentage: float
    orphan_examples: list[str]
    evidence: dict


class ProfileTablesResponse(BaseModel):
    status: str
    profileMode: Literal["fast", "full"]
    sampleSizePerTable: Optional[int]
    tableCount: int
    findingCount: int
    tables: list[TableProfileSummary]
    findings: list[FindingPayload]
    aggregatedIssues: list[AggregatedIssuePayload]
    relationships: list[RelationshipPayload]


def _load_csv_string(csv_content: str) -> pd.DataFrame:
    """Matches Phase 1's own io.py reading convention exactly: every cell
    read as a raw string, with pandas' automatic NA detection disabled.
    Getting this wrong (e.g. letting pandas coerce "NA"/"" to NaN on load)
    would silently break Phase 1's own null-vs-empty-string distinction
    before its detectors ever see the data."""
    return pd.read_csv(
        io.StringIO(csv_content),
        dtype=str,
        keep_default_na=False,
        na_filter=False,
    )


@router.post("/internal/profile/tables", response_model=ProfileTablesResponse)
def post_profile_tables(payload: ProfileTablesRequest) -> ProfileTablesResponse:
    # A synchronous FastAPI handler is dispatched to its worker threadpool,
    # keeping CPU-heavy pandas/profiling work off the ASGI event loop.
    started = perf_counter()
    input_chars = sum(len(t.csvContent) for t in payload.tables)
    loaded_tables: dict[str, pd.DataFrame] = {
        t.tableName: _load_csv_string(t.csvContent) for t in payload.tables
    }
    source_row_counts = {name: len(frame) for name, frame in loaded_tables.items()}
    loaded_at = perf_counter()
    logger.info(
        "profile input loaded tables=%d rows=%d chars=%d mode=%s elapsed_ms=%.1f",
        len(loaded_tables),
        sum(source_row_counts.values()),
        input_chars,
        payload.profileMode,
        (loaded_at - started) * 1000,
    )

    if payload.profileMode == "fast":
        # Deterministic sampling retains original DataFrame index labels.
        # The detectors use those labels as source CSV row positions, so do
        # not reset_index() after sampling.
        tables: dict[str, pd.DataFrame] = {
            name: (
                frame.sample(n=payload.sampleSizePerTable, random_state=42).sort_index()
                if len(frame) > payload.sampleSizePerTable
                else frame
            )
            for name, frame in loaded_tables.items()
        }
        del loaded_tables
        estimated = True
    else:
        tables = loaded_tables
        estimated = False

    profiled_row_counts = {name: len(frame) for name, frame in tables.items()}
    sampled_at = perf_counter()
    logger.info(
        "profile analysis rows=%d/%d sample_limit=%s elapsed_ms=%.1f",
        sum(profiled_row_counts.values()),
        sum(source_row_counts.values()),
        payload.sampleSizePerTable if estimated else "full",
        (sampled_at - loaded_at) * 1000,
    )

    result = DataProfiler().profile(tables)
    profiled_at = perf_counter()
    aggregated_issues, finding_count = aggregate_profile_result(
        result,
        tables,
        source_row_counts=source_row_counts,
        estimated=estimated,
    )
    adapted_at = perf_counter()
    # Reuses the same profile tables and already-computed column profiles.
    relationships = infer_relationships(tables, result.tables)
    related_at = perf_counter()
    logger.info(
        "profile computation complete mode=%s tables=%d findings=%d relationships=%d load_ms=%.1f profile_ms=%.1f adapter_ms=%.1f relationships_ms=%.1f total_ms=%.1f",
        payload.profileMode,
        len(tables),
        finding_count,
        len(relationships),
        (loaded_at - started) * 1000,
        (profiled_at - loaded_at) * 1000,
        (adapted_at - profiled_at) * 1000,
        (related_at - adapted_at) * 1000,
        (related_at - started) * 1000,
    )

    table_summaries = [
        TableProfileSummary(
            tableName=dp.table,
            rowCount=source_row_counts[dp.table],
            profiledRowCount=dp.row_count,
            columnCount=dp.column_count,
            columns=[
                ColumnProfileSummary(
                    columnName=cp.name,
                    inferredType=cp.inferred_type,
                    nullCount=cp.null_count,
                    nullPercentage=cp.null_percentage,
                    distinctCount=cp.unique_count,
                    uniquenessRatio=(
                        cp.unique_count / cp.non_null_count if cp.non_null_count > 0 else None
                    ),
                )
                for cp in dp.columns
            ],
        )
        for dp in result.tables
    ]

    return ProfileTablesResponse(
        status="profiled",
        profileMode=payload.profileMode,
        sampleSizePerTable=payload.sampleSizePerTable if estimated else None,
        tableCount=len(tables),
        findingCount=finding_count,
        tables=table_summaries,
        # Keep the legacy field as an empty array for backward-compatible
        # response shape; compact issue summaries carry the exact counts.
        findings=[],
        aggregatedIssues=[
            AggregatedIssuePayload(**issue) for issue in aggregated_issues
        ],
        relationships=[
            RelationshipPayload(
                parent_table=r.parent_table,
                parent_column=r.parent_column,
                child_table=r.child_table,
                child_column=r.child_column,
                confidence=r.confidence,
                confidence_band=r.confidence_band,
                status="inferred",
                value_overlap=r.value_overlap,
                orphan_count=(
                    min(
                        source_row_counts[r.child_table],
                        int((r.orphan_percentage / 100) * source_row_counts[r.child_table] + 0.5),
                    )
                    if estimated else r.orphan_count
                ),
                orphan_percentage=r.orphan_percentage,
                orphan_examples=r.orphan_examples,
                evidence={
                    **r.evidence,
                    "analysisMode": payload.profileMode,
                    "estimated": estimated,
                    "profiledChildRows": profiled_row_counts[r.child_table],
                    "sourceChildRows": source_row_counts[r.child_table],
                },
            )
            for r in relationships
        ],
    )
