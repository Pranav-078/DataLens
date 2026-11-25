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
from typing import Optional

import pandas as pd
from fastapi import APIRouter
from pydantic import BaseModel

from app import _vendor_path  # noqa: F401  (must run before importing datasage_profiler)
from datasage_profiler.engine import DataProfiler

from app.adapters.phase1_adapter import adapt_profile_result
from app.relationships.inference import infer_relationships

router = APIRouter()


class TablePayload(BaseModel):
    tableName: str
    csvContent: str


class ProfileTablesRequest(BaseModel):
    tables: list[TablePayload]


class FindingPayload(BaseModel):
    issue_type: str
    dimension: str
    table: str
    row_uid: str
    column: Optional[str]
    severity: str
    evidence: dict


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
    tableCount: int
    findingCount: int
    tables: list[TableProfileSummary]
    findings: list[FindingPayload]
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
async def post_profile_tables(payload: ProfileTablesRequest) -> ProfileTablesResponse:
    tables: dict[str, pd.DataFrame] = {
        t.tableName: _load_csv_string(t.csvContent) for t in payload.tables
    }

    result = DataProfiler().profile(tables)
    findings = adapt_profile_result(result, tables)
    # Reuses the SAME `tables` dict and the SAME already-computed Phase 1
    # column profiles (result.tables) — no second CSV parse, no second
    # profiling pass. See app/relationships/inference.py for the algorithm;
    # nothing about it is duplicated here.
    relationships = infer_relationships(tables, result.tables)

    table_summaries = [
        TableProfileSummary(
            tableName=dp.table,
            rowCount=dp.row_count,
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
        tableCount=len(tables),
        findingCount=len(findings),
        tables=table_summaries,
        findings=[
            FindingPayload(
                issue_type=f.issue_type,
                dimension=f.dimension,
                table=f.table,
                row_uid=f.row_uid,
                column=f.column,
                severity=f.severity,
                evidence=f.evidence,
            )
            for f in findings
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
                orphan_count=r.orphan_count,
                orphan_percentage=r.orphan_percentage,
                orphan_examples=r.orphan_examples,
                evidence=r.evidence,
            )
            for r in relationships
        ],
    )
