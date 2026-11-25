# DataSage Phase 2 — Slices A–E delivery package

This package contains every new or modified file from Phase 2's five
slices (A: Python relationship inference, B: FastAPI integration, C:
Node/Prisma relationship persistence, D: quality scoring, E: read APIs).
It is an **overlay**, not a full project: extract it on top of your
existing DataSage checkout, and every path lands exactly where it already
belongs. Nothing outside this file list is touched.

## What's in here (26 files)

```
backend-python/
  app/relationships/__init__.py            NEW  — Slice A
  app/relationships/inference.py           NEW  — Slice A
  app/api/profile_tables.py                MODIFIED — Slice B (adds `relationships` field)
  pyproject.toml                           MODIFIED — Slice A (packaging fix, see below)
  tests/test_relationships_inference.py    NEW  — Slice A
  tests/test_profile_tables_endpoint.py    MODIFIED — Slice B

backend-node/
  src/repo/types.ts                        MODIFIED — Slice C + E (relationship/score + read methods)
  src/repo/profilingRepo.ts                MODIFIED — Slice C + D (persist relationships + score)
  src/repo/queryRepo.ts                    NEW  — Slice E
  src/services/uploadProfilingService.ts   MODIFIED — Slice C (relationshipCount)
  src/modules/uploads/profilerClient.ts    MODIFIED — Slice C (relationships field/type)
  src/modules/uploads/upload.controller.ts MODIFIED — Slice C (relationshipCount in response)
  src/modules/uploads/issueAggregation.ts  UNCHANGED — included for reference only
  src/modules/quality/qualityScore.ts      NEW  — Slice D
  src/modules/projects/projects.controller.ts  NEW — Slice E
  src/modules/projects/projects.routes.ts      NEW — Slice E
  src/errors/AppError.ts                   MODIFIED — Slice C + E (versionNotFound added)
  src/app.ts                               MODIFIED — Slice E (registers projectsRouter)

  tests/fakeProfilingDb.ts                 MODIFIED — read methods added, id/createdAt bug fixed
  tests/profilingRepo.test.ts              MODIFIED — relationship + quality-score persistence tests
  tests/uploadProfilingService.test.ts     MODIFIED — relationships field in mocks
  tests/profileTables.test.ts              MODIFIED — relationships field in mocks
  tests/upload.endpoint.test.ts            MODIFIED — relationships field, relationshipCount assertion
  tests/qualityScore.test.ts               NEW  — Slice D
  tests/projects.endpoint.test.ts          NEW  — Slice E
  tests/issueAggregation.test.ts           UNCHANGED — included for reference only
```

**Not included, not touched:** `backend-python/vendor/datasage_profiler/`
(frozen Phase 1, byte-verified untouched), `datasage-fixtures` (external,
authoritative, never modified), `prisma/schema.prisma` (no schema changes
in any of Slices A–E — every new field already existed on
`InferredRelationship`/`QualityScore`).

**No new dependencies.** Slice A's confidence weighting uses Python's
stdlib `difflib`, not a new fuzzy-matching library. Slice D/E add no npm
packages. The only `pyproject.toml` change is a packaging fix (see below),
not a new dependency.

## 1. Extract into your project

From your DataSage project root (the folder containing `backend-node/`
and `backend-python/` as siblings):

```powershell
Expand-Archive -Path DataSage-Phase2-SliceA-E.zip -DestinationPath . -Force
```

`-Force` overwrites only the 26 files listed above, at their exact
existing paths. Nothing else in your project is touched.

## 2. Install (no new dependencies, but do this to be safe)

```powershell
cd backend-node
npm install
npx prisma generate
cd ..\backend-python
python -m venv .venv
.venv\Scripts\pip install -e ".[dev]"
cd ..
```

**About the `pyproject.toml` change:** it adds
`[tool.setuptools.packages.find] include = ["app*"]`. Without it, a cold
`pip install -e .` fails with *"Multiple top-level packages discovered in
a flat-layout: ['app', 'vendor']"*, because setuptools can't tell `app/`
and `vendor/` apart as installable packages. `vendor/` was never meant to
be installed — it's loaded via `sys.path` in `app/_vendor_path.py`. This
is a real bug fix, found when this package was built from a cold
reinstall; it does not change any runtime behavior.

## 3. Verify — Windows PowerShell

```powershell
# Python: full suite, relationship inference, and the endpoint tests
cd backend-python
.venv\Scripts\pytest -v

# Node: typecheck, lint, full suite
cd ..\backend-node
npx tsc -p tsconfig.json --noEmit
npm run lint
npx vitest run
```

**Expected results** (reproduced in this environment immediately before
packaging):

| Check | Result |
|---|---|
| Python suite | **65 passed, 4 skipped** |
| Node suite | **152 passed, 4 skipped** |
| TypeScript | clean, exit 0 |
| ESLint | clean, 0 errors/0 warnings |

The 4 Python skips and 4 Node skips are the same cause in both cases: they
depend on the external `datasage-fixtures` repository and/or a live
Python subprocess + Postgres, neither of which exist in *this* build
environment. They are not failures — they're environment-gated tests that
degrade to a skip rather than a false failure when their dependency is
absent. On your machine, once `datasage-fixtures` is checked out as a
sibling of your project root, those should run for real.

### Live, real verification already done (not fake-DB)

Before packaging, the real Python service was booted standalone (no
mocking) and hit directly:

```powershell
cd backend-python
$env:PROFILER_PORT="8098"
.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8098
```

```powershell
# in a second terminal:
Invoke-RestMethod http://127.0.0.1:8098/health
Invoke-RestMethod -Method Post http://127.0.0.1:8098/internal/profile/tables `
  -ContentType "application/json" `
  -Body '{"tables":[{"tableName":"customers","csvContent":"id,email\n1,a@x.com\n2,\n3,c@x.com\n"}]}'
```

This returned real Phase 1 findings and, with a second table added, a
real Phase 2 relationship (`customers.id → orders.customer_id`,
confidence `0.98`) whose `score_terms` were hand-verified against the
documented formula: `0.55×1.0 + 0.20×0.9 + 0.15×1.0 + 0.10×1.0 = 0.98`. ✓

### What is still blocked — real PostgreSQL

**Not verified, and not claimed as verified:** the Node service cannot
even start in the environment this package was built in, because
`prisma generate` has never successfully run there (its engine-binary
host is unreachable from that sandbox). Every Node-side test in this
package runs against `tests/fakeProfilingDb.ts`, an in-memory stand-in —
this proves the application logic (status transitions, ID resolution,
transaction structure, response shapes) but **cannot** prove real
Postgres/Prisma behavior. On a normal machine with internet access this
is not expected to be an issue; it was purely a sandbox network
restriction.

**To complete real verification on your machine:**

```powershell
# 1. Start Postgres (adjust to your setup)
docker compose up -d db

# 2. Generate the client and migrate (first time only)
cd backend-node
npx prisma generate
npx prisma migrate dev --name init

# 3. Start both services
cd ..\backend-python
.venv\Scripts\uvicorn app.main:app --host 0.0.0.0 --port 8001
# in another terminal:
cd backend-node
npm run dev

# 4. Upload real data and read it back
curl.exe -X POST http://localhost:8000/uploads/validate `
  -F "files=@C:\path\to\customers.csv" `
  -F "files=@C:\path\to\orders.csv"
# note the projectId and versionId from the response, then:
curl.exe http://localhost:8000/projects/<projectId>
curl.exe http://localhost:8000/projects/<projectId>/versions/<versionId>/tables
curl.exe http://localhost:8000/projects/<projectId>/versions/<versionId>/issues
curl.exe http://localhost:8000/projects/<projectId>/versions/<versionId>/relationships
curl.exe http://localhost:8000/projects/<projectId>/versions/<versionId>/quality-score

# 5. Specifically worth checking (flagged as the most likely real-DB surprise):
#    does fileSizeBytes (a BigInt column) serialize correctly in the
#    /tables JSON response, or does it error/stringify unexpectedly?

# 6. Restart Node (Ctrl+C, npm run dev again) and repeat step 4 to confirm
#    persisted records survive a restart.

# 7. Try reading the same versionId under a DIFFERENT projectId in the
#    URL — expect 404 VERSION_NOT_FOUND, never the data.
```

## API surface added in Slice E

All seven endpoints are read-only, scoped by project AND version (a
version belonging to a different project returns the same
`VERSION_NOT_FOUND` as a nonexistent one, so existence can't be
enumerated across projects):

```
GET /projects/:projectId
GET /projects/:projectId/versions
GET /projects/:projectId/versions/:versionId
GET /projects/:projectId/versions/:versionId/tables
GET /projects/:projectId/versions/:versionId/issues?page=&pageSize=
GET /projects/:projectId/versions/:versionId/relationships
GET /projects/:projectId/versions/:versionId/quality-score
```

## Known, documented limitation (Slice D)

Dimension scores (completeness/validity/uniqueness/consistency) use a
`totalRows`-weighted average of each issue's `affectedPercentage`, not an
exact deduplicated row-level applicability count. This is stated in
`qualityScore.ts`'s module docstring and in every computed score's
`calculationBreakdown.knownLimitation` field — not hidden.
