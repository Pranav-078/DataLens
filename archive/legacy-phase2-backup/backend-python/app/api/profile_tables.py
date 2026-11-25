"""
The real profiling endpoint, built on the vendored Phase 1 profiler plus
the Phase 0 adapter.

Deliberately a NEW route (/internal/profile/tables), not a replacement of
the existing /internal/profile stub in profile_stub.py. That stub's exact
request/response shape is what backend-node's profilerClient.ts and its
passing test suite currently depend on; changing it in place would be a
Node-facing change smuggled into a step that is explicitly Python-only.
Switching Node over to this route is deferred to the next, separately
approved step.
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


class ProfileTablesResponse(BaseModel):
    status: str
    tableCount: int
    findingCount: int
    tables: list[TableProfileSummary]
    findings: list[FindingPayload]


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
    )
