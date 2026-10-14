# DataSage Phase 1 Python/Pandas Profiler

This directory contains an independent, integration-friendly profiling engine.
It does not modify or depend on the existing Node.js backend, React frontend,
Prisma/PostgreSQL, authentication, RAG, NL-to-SQL, deployment, or FastAPI
integration.

## Scope

The engine produces deterministic JSON for:

- table shape and column profiles: dimensions, names, inferred types, unique
  counts, null counts/percentages, and empty-string counts;
- full-record duplicates and repeated values in candidate-key-like columns;
- invalid or mixed numeric values, invalid dates, and inconsistent date formats;
- whitespace, casing, empty-string, and replacement/control-character issues;
- missing values in explicitly configured or required-like fields;
- numeric outliers using configurable Tukey IQR thresholds;
- suspicious categorical variants only when a repeated dominant value makes the
  variant plausible.

Foreign-key/relationship/orphan detection, quality scoring, and service
integration are deliberately not implemented in Phase 1.

## Layout

```text
datasage_profiler/
  contracts.py       detector extension contract
  config.py          thresholds and naming heuristics
  models.py          JSON result models
  profiling.py       dataset/column profile builder
  detectors.py       Phase 1 detector implementations
  engine.py          deterministic orchestration
  io.py              CSV/JSON/parquet table loading
  cli.py             datasage-profile command
  evaluate.py        official fixture evaluation command
tests/               unit, edge-case, determinism, and loader tests
docs/DETECTORS.md    detector behavior and heuristic notes
```

## Run locally

Dependencies are declared in `pyproject.toml`.

```bash
pytest
python -m compileall -q datasage_profiler tests
datasage-profile path/to/table-or-directory -o profile.json
```

The loader accepts one CSV, JSON, or parquet table, or recursively loads
supported files from a directory. Files under `ground_truth/` and files named
`ground_truth*.json` are excluded from table loading.

## Evaluate Phase 0 fixtures

There is no separate "datasage-fixtures" repository. The evaluator instead
reads the fixtures DataSage Phase 0 already generates under `DataSage/data/`:

```bash
datasage-evaluate /path/to/DataSage/data -o evaluation.json
```

The expected layout is:

```text
data/
  clean/               plain, defect-free tables
  corrupted/
    customers.csv, orders.csv, ...
    ground_truth.json  defect list for this fixture's tables
```

`ground_truth.json` lives inside the fixture directory it describes (matching
Phase 0's own `data/corrupted/ground_truth.json`), not in a separate shared
folder. Either fixture directory (`clean`, `corrupted`) may be absent; the
evaluator reports it as unavailable rather than failing.

The evaluator reports observed findings and any ground-truth labels it can
read. It does not claim coverage for unavailable fixtures, and it does not
turn Phase 2 or Phase 3 expectations into Phase 1 findings.