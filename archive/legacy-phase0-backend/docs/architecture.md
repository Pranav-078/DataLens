# DataSage Architecture

## Service boundary: Node BFF + stateless Python compute

`backend-node` owns everything stateful: HTTP routing, the Postgres
connection (via Prisma), file uploads, job orchestration, and (in later
phases) LLM calls and RAG orchestration. `backend-python` owns nothing
stateful — no database connection, no file persistence of its own. It
receives a request, computes something, and returns a response.

This is why `backend-python/app/api/profile_stub.py` in Phase 0 takes a
`tableCount` and returns a canned `{"status": "stub_ok", "receivedTables": N}`
rather than touching a database: Phase 1's real profiling endpoint will
follow the same shape — pandas DataFrames in, a structured profile out —
with all persistence happening back in Node after the response returns.

**Why this split, not a single Python backend, and not a Node service that
also touches the database from both sides:** pandas/DuckDB/sqlglot work
naturally are Python's strengths, but a service that's *sometimes* stateful
and *sometimes* not becomes two services with none of the isolation
benefits of either. Keeping Python fully stateless means it can be scaled,
restarted, or replaced without any data-consistency concern — there's
nothing in it to be consistent.

## The five profiler error codes

`backend-node/src/modules/uploads/profilerClient.ts` maps every distinct
failure mode of calling the Python service to its own `AppError` code,
rather than a single generic "profiler failed":

| Code | Meaning | Client implication |
|---|---|---|
| `PROFILER_UNAVAILABLE` | Connection refused / DNS failure — the service isn't reachable at all | Retry later |
| `PROFILER_TIMEOUT` | Reachable, but didn't respond within the configured timeout | Retry later, possibly with a longer timeout |
| `PROFILER_NOT_IMPLEMENTED` | Upstream returned 501 | This operation genuinely doesn't exist yet — not a transient failure |
| `PROFILER_ERROR` | Upstream returned another 5xx | Something is actually broken server-side |
| `PROFILER_BAD_RESPONSE` | Got a 2xx, but the body doesn't match the expected contract | A bug (ours or theirs), not a transient condition |

These are distinguished because the correct UI/retry behavior differs for
each — collapsing them into one code would force the caller to re-derive
this distinction from HTTP status codes anyway.

## Data storage: Postgres for metadata, DuckDB for data (Phase 1+)

Postgres (`backend-node/prisma/schema.prisma`) holds everything about a
dataset except the dataset itself: projects, versions, column statistics,
issues, relationships, scores, embeddings. The actual uploaded CSV rows are
planned to live in one DuckDB file per `dataset_versions` row
(`duckdb_path`), not as rows inside Postgres tables.

Rationale: dynamic per-upload table creation in Postgres means managing DDL,
name collisions, and read-only role grants for the eventual NL-to-SQL
feature. A DuckDB file per version gets isolation for free (it's a
filesystem boundary), read-only enforcement for free (a connection flag),
and version deletion for free (`rm`). This decision is recorded now, before
Phase 1 needs it, because it shapes `dataset_versions.duckdb_path` in the
schema already.

## Why the Prisma schema has 16 tables, not 14

Earlier design discussion used "14 tables" as shorthand; counting the
actual finalized table list (projects, dataset_versions, dataset_tables,
dataset_columns, column_statistics, quality_issues, quality_scores,
inferred_relationships, ai_explanations, documents, document_chunks,
chat_sessions, chat_messages, sql_queries, reports, jobs) gives 16. Every
table carries a one-line justification comment directly in
`schema.prisma`; none were added or removed to force a particular count.

## The upload validation module

`backend-node/src/modules/uploads/upload.validator.ts` runs, in order:
path safety → file count → per-file size → file-type sniffing (magic
bytes, not just extension) → strict UTF-8 validation → CSV structural
parsing (ragged rows, duplicate columns, header-only files) → batch-level
duplicate-filename and table-name-collision checks.

Each check is a small, independently-exported, independently-tested
function. `validateUploadBatch` is the only orchestrator; nothing else in
the codebase re-implements any of these checks.

**Two bugs found and fixed during development, worth remembering:**
1. `file-type`'s `fileTypeFromBuffer` can *throw* (not just return
   `undefined`) when a buffer's leading bytes match a known binary format's
   magic signature but the buffer is truncated before that format's
   structure completes. A truncated PNG upload triggered this. Treated as
   a detected-and-rejected binary file, not allowed to crash the request.
2. `jschardet` (used only to produce a friendlier "detected encoding" hint)
   is CommonJS-only with no ESM-friendly export; imported via
   `createRequire` rather than a top-level `import`, since this project's
   `package.json` declares `"type": "module"`.

## Error envelope contract

Every error response has the shape:
```json
{ "error": { "code": "STRING_CODE", "message": "...", "details": {...}, "requestId": "..." } }
```
The frontend is expected to switch on `code`, never `message` — see
`backend-node/src/errors/errorCodes.ts` for the closed set of codes and
their HTTP status mapping (`AppError`'s status is always derived from its
code; there is no way to construct one with a mismatched pair).

## Async safety in Express 4

Express 4 does not forward a rejected promise from an `async` route handler
to error-handling middleware automatically — an unhandled rejection just
hangs the request. Every async handler in this codebase is wrapped with
`middleware/asyncHandler.ts`, discovered as a real bug (not a
precautionary pattern) while building the upload endpoint.

## The evaluation harness

`evaluation/detector_contract.py` defines the `Finding` shape every Phase 1
detector's output must satisfy — critically, every `Finding` carries a
`row_uid`, which is what allows grading at the level of individual rows
rather than aggregate counts (two detectors can produce the same finding
*count* while flagging entirely different rows; only row-level comparison
catches that).

`data/generators/make_clean_data.py` assigns every generated row a
deterministic `row_uid` (via `uuid5`, seeded — not `uuid4`, which would be
non-reproducible). `data/generators/corrupt_data.py` injects defects by
`row_uid` and records each injection in `data/corrupted/ground_truth.json`,
whose shape is formally defined in `evaluation/ground_truth.schema.json`.

`evaluation/detector_eval.py` loads that manifest, runs every detector in
`evaluation/registry.py`'s `DETECTOR_REGISTRY` (empty in Phase 0, by
design), and computes precision/recall per defect type — correctly
reporting `n/a` for precision for a defect type nothing detects yet,
rather than a `ZeroDivisionError` or a misleading `0.0`.

## Known gap: Prisma migration not generated in the development sandbox

The development sandbox used to build this phase had network access
restricted to an allowlist that did not include `binaries.prisma.sh`,
which Prisma's CLI needs to download its query/schema engine binaries. This
blocked `prisma generate`, `prisma validate`, and `prisma migrate diff` for
the entire session. The schema itself was reviewed manually (model count,
relation pairing, cascade behavior) but has not been executed against a
live PostgreSQL instance. This is expected to be a non-issue in any
environment with normal internet access — see the README's "Known
limitation" section for the exact commands to complete verification.
