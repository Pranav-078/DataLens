# DataSage

AI-assisted, multi-table data quality and schema intelligence tool for
related CSV datasets. See `docs/architecture.md` for the full design.

**Status: Phase 0 (foundation) complete.** No profiling, RAG, or NL-to-SQL
exists yet — this phase is the skeleton everything else builds on: config,
logging, error handling, the database schema, upload validation, the
Node↔Python service boundary, and the evaluation harness that will grade
Phase 1's detectors.

## Architecture at a glance

```
React frontend (Phase 6+)
        │
        ▼
Node.js/Express BFF (backend-node)   ← owns HTTP, auth, DB, uploads, orchestration
        │
        ├── PostgreSQL 16 + pgvector  (metadata, issues, embeddings — 16 tables)
        ├── Python/FastAPI  (backend-python)  ← stateless compute only, no DB access
        └── DuckDB (one file per dataset version, Phase 1+)  ← raw analytical data
```

Full rationale for this split (why Node owns state and Python stays
stateless, why DuckDB per-version rather than rows-in-Postgres) is in
`docs/architecture.md`.

## Prerequisites

- Node.js 20+
- Python 3.11+
- Docker + Docker Compose (for the full stack; not required to run tests)

## Setup

```bash
cp .env.example .env
make install
```

`make install` sets up three independent environments:
- `backend-node/node_modules` (npm)
- `backend-python/.venv` (the FastAPI service's own deps)
- `.venv` at the repo root (pandas/pytest/jsonschema, for `data/generators/`
  and `evaluation/` — deliberately separate from backend-python's service
  dependencies, since these are dev tooling, not something that ships)

## Running the full stack

```bash
make dev        # docker compose up --build
```

Then:
```bash
curl localhost:8000/health         # Node liveness
curl localhost:8000/health/ready   # Node readiness (checks Postgres + pgvector)
curl localhost:8001/health         # Python liveness
```

**First-time database setup** — Prisma's migration needs to be generated
once, against a real network (see "Known limitation" below for why this
repo doesn't ship a pre-generated one):
```bash
cd backend-node
npx prisma migrate dev --name init
```
This creates `backend-node/prisma/migrations/`, which should be committed.
After that, `docker compose up` applies it automatically via
`prisma migrate deploy` in the container's startup command.

## Running tests

```bash
make test           # everything: Node + Python service + evaluation harness
make test-node      # backend-node's vitest suite (52 tests)
make test-python    # backend-python's pytest suite (8 tests)
make test-eval      # evaluation harness's own pytest suite (24 tests)
make typecheck      # tsc --noEmit across backend-node, src + tests
```

None of the test suites require Docker or a live database — `db/prisma.ts`
is mocked in every Node test that touches it, by design, not as a
workaround.

## The evaluation harness

```bash
make generate-data   # writes data/clean/ and data/corrupted/, deterministically
make evaluate        # grades registered detectors against data/corrupted/ground_truth.json
```

`data/generators/make_clean_data.py` produces a related 4-table dataset
(customers/orders/products/payments), with every row carrying a stable
`row_uid`. `data/generators/corrupt_data.py` injects 9 known defect types
and writes `data/corrupted/ground_truth.json`, keyed by `row_uid` — this is
the answer key `evaluation/detector_eval.py` grades against.

**Phase 0 has zero registered detectors.** Running `make evaluate` now
correctly reports 0 findings, `n/a` precision, and 0% recall for every
defect type — proving the harness's plumbing (loading data, loading ground
truth, computing metrics without dividing by zero, writing a report) works
correctly before Phase 1 adds anything real to grade. See
`evaluation/registry.py` for how a Phase 1 detector registers itself.

## Known limitation: Prisma engine binary

This project's Prisma schema (`backend-node/prisma/schema.prisma`, 16
justified tables) has been reviewed and is believed correct, but has not
been executed against a live PostgreSQL instance during this development
session, because that session's sandbox blocked network access to
`binaries.prisma.sh` (Prisma's engine-binary host). This is **not** expected
to affect a normal machine or CI environment with standard internet
access — `docker compose up` will run `prisma generate` and
`prisma migrate deploy` as part of the container build/startup, both of
which need that host reachable.

**To complete verification on your machine:**
```bash
docker compose up --build
docker compose exec db psql -U datasage -d datasage -c "\dt"      # expect 16 tables
docker compose exec db psql -U datasage -d datasage -c "\d document_chunks"  # expect embedding | vector(1536)
curl localhost:8000/health/ready   # expect {"status":"ready",...}
```

## Full local verification: the real upload → profiling → persistence pipeline

Everything below was verified in this project's development sandbox using
an in-memory fake in place of PostgreSQL (see `docs/architecture.md`'s
Phase 1 integration addendum for exactly why, and which tests that
applies to). The commands below are what actually proves it end-to-end
against a real database, which the sandbox could not do.

**1. Install and generate the Prisma client, run the migration:**
```bash
cd backend-node
npm install
npx prisma generate
npx prisma migrate dev --name init      # first time only; creates prisma/migrations/
```

**2. Start PostgreSQL** (if not already using `docker compose up` for it):
```bash
docker compose up -d db
```

**3. Start the Python profiling service:**
```bash
cd backend-python
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8001
```

**4. Start the Node service** (separate terminal):
```bash
cd backend-node
npm run dev
```

**5. Run the real pipeline against the authoritative fixtures** (adjust the
path to wherever you have `datasage-fixtures` checked out):
```bash
FIXTURES=../datasage-fixtures/data

curl -X POST http://localhost:8000/uploads/validate \
  -F "files=@${FIXTURES}/v1_clean/customers.csv" \
  -F "files=@${FIXTURES}/v1_clean/orders.csv" \
  -F "files=@${FIXTURES}/v1_clean/products.csv" \
  -F "files=@${FIXTURES}/v1_clean/order_items.csv" \
  -F "files=@${FIXTURES}/v1_clean/product_variants.csv" \
  -F "files=@${FIXTURES}/v1_clean/tickets.csv" \
  -F "files=@${FIXTURES}/v1_clean/ticket_events.csv"
# expect: "profiling": { "findingCount": 0, "issueCount": 0 }
```
Repeat with `${FIXTURES}/v2_dirty` in place of `v1_clean` — expect a
non-zero `findingCount`/`issueCount`. Note the `versionId` and `jobId`
from each response for the next step.

**6. Verify the records directly in Postgres:**
```bash
docker compose exec db psql -U datasage -d datasage -c "
  SELECT id, version_number, status FROM dataset_versions ORDER BY created_at DESC LIMIT 5;
"
docker compose exec db psql -U datasage -d datasage -c "
  SELECT status, job_type, error_message FROM jobs ORDER BY created_at DESC LIMIT 5;
"
docker compose exec db psql -U datasage -d datasage -c "
  SELECT table_name, row_count, file_path FROM dataset_tables
  WHERE version_id = '<versionId from the v2_dirty response>';
"
docker compose exec db psql -U datasage -d datasage -c "
  SELECT issue_type, dimension, severity, affected_rows, total_rows, fingerprint
  FROM quality_issues WHERE version_id = '<versionId from the v2_dirty response>'
  ORDER BY severity DESC;
"
```
For `v1_clean`: expect `dataset_versions.status = 'ready'`, `jobs.status =
'succeeded'`, zero rows in `quality_issues` for that version. For
`v2_dirty`: same statuses, plus quality_issues rows whose `fingerprint`
values are stable across repeated runs against the same data.

**7. Verify failure handling** — stop the Python service, then repeat step
5 against either fixture version:
```bash
# with the Python service NOT running:
curl -X POST http://localhost:8000/uploads/validate -F "files=@${FIXTURES}/v1_clean/customers.csv" [...]
# expect: 503, error.code "PROFILER_UNAVAILABLE"
```
Then check Postgres:
```bash
docker compose exec db psql -U datasage -d datasage -c "
  SELECT status FROM dataset_versions ORDER BY created_at DESC LIMIT 1;
"  # expect 'failed', NOT 'profiling'
docker compose exec db psql -U datasage -d datasage -c "
  SELECT status, error_message FROM jobs ORDER BY created_at DESC LIMIT 1;
"  # expect 'failed' with a real error_message, NOT 'running'
```

## Project structure

```
backend-node/     Express BFF: HTTP, Prisma/Postgres, upload validation,
                   profiling orchestration, persistence (repo/, services/)
backend-python/   FastAPI: real profiling via the vendored Phase 1 engine
                   (vendor/datasage_profiler) + the Phase 0 adapter (adapters/)
data/generators/  Deterministic clean-data + corruption scripts
evaluation/       Detector contract, ground-truth schema, grading harness
docs/             Architecture notes, incl. the Phase 1 integration addendum
```

## Limitations

- No authentication — single-user tool by design, not yet addressed.
- No RAG or NL-to-SQL yet, and no relationship/FK/orphan detection
  (Phase 2) — this integration deliberately stopped short of that.
- No Projects CRUD API — `projectId` is optional on upload; omitted means
  auto-create, supplied-but-nonexistent is a real 404 (see
  `docs/architecture.md`'s Phase 1 integration addendum).
- Prisma migration not generated/applied in the development sandbox that
  built this integration (network-restricted — see above); every
  persistence test in this repo runs against an in-memory fake, not real
  PostgreSQL. The commands above are what completes that verification.
