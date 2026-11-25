# Detector behavior

All detectors implement the `Detector` contract in
`datasage_profiler/contracts.py`:

```python
class Detector(Protocol):
    name: str
    def detect(self, context: DetectorContext) -> list[Issue]: ...
```

Add a detector by implementing that method and passing the detector to
`DataProfiler(detectors=...)`. Each `Issue` receives a stable SHA-256-derived
ID from its complete finding payload. Issue lists and summary maps are sorted
before JSON serialization.

## Dataset profiling

CSV values are read as strings so invalid numeric/date tokens are not silently
coerced away. Missing-value detection includes configured tokens (`null`,
`none`, `na`, `n/a`, `nan`, and the empty string). The profile keeps true
null-like values and empty strings in separate counters, while detectors treat
both as missing. Types are inferred from parse ratios and conservative
column-name hints.

## Duplicates

Full records are grouped by their complete row contents. Candidate-key checks
only run for names matching configured identifier patterns such as `id`, `key`,
`uuid`, `email`, or `code`. Missing values are excluded from candidate-key
groups.

> **Known Phase 1 limitation — foreign-key columns look like repeated candidate
> keys.** The candidate-key check is single-table and name-only: it has no
> notion of which table "owns" an identifier, so a legitimate foreign key
> (e.g. `orders.customer_id`, which is expected to repeat once per order
> placed by the same customer) matches the same `id`/`key`/`uuid`/`email`/`code`
> name patterns as a true primary/candidate key and is reported as
> `duplicate_candidate_key` every time it repeats. On multi-table data this can
> produce a large number of findings that are not really duplicate-key defects.
> This is intentional for Phase 1 — telling a primary key from a foreign key
> requires cross-table relationship awareness, which is explicitly out of scope
> here (see "Explicit exclusions" below) — and the detector is not weakened or
> disabled to work around it. **Phase 2 should resolve this** by adding
> relationship/schema intelligence (e.g. inferred or declared foreign keys) so
> that FK-shaped columns can be excluded from, or re-classified within, the
> candidate-key duplicate check before it reaches end users.

## Type quality

Numeric-like columns produce `invalid_numeric` findings for non-parsable
non-missing tokens. Date-like columns use explicit common formats first and
then pandas parsing, and report invalid dates plus more than one observed
format. Mixed numeric/non-numeric columns that are not name-hinted produce a
`mixed_type` warning.

## String quality

The detector reports leading/trailing whitespace, exact empty strings,
replacement characters (`�`), and non-tab/newline/carriage-return control
characters. Casing findings require multiple raw variants that normalize to
the same value.

## Required fields

`required_columns` is authoritative. Without explicit configuration, the
default heuristic treats columns whose names look like identifiers or common
business fields (`id`, `name`, `email`, `status`, `date`, `amount`, and
similar patterns) as required-like. Every finding documents whether it came
from explicit configuration or this heuristic. This is intentionally a
precision-oriented heuristic, not a schema guarantee.

## Numeric outliers

The default is Tukey's rule:

```text
lower = Q1 - 1.5 * IQR
upper = Q3 + 1.5 * IQR
```

Detection requires at least eight non-null numeric values by default. Both
the minimum sample size and multiplier are configurable through
`ProfilerConfig` or the CLI flags. A zero-IQR column is skipped.

## Categorical value consistency

Only low-cardinality string/boolean columns are considered. A rare value must
be very close to a repeated dominant value by compact-string edit distance or
sequence similarity. This avoids treating every legitimate rare category as a
defect. Case/spacing-only variants remain the responsibility of the string
quality detector.

## Explicit exclusions

No detector inspects relationships between tables, foreign keys, orphan
records, quality scores, or API/service integration. Those belong to later
phases. In particular, see the foreign-key note under "Duplicates" above: the
candidate-key duplicate check cannot distinguish a primary/candidate key from
a foreign key, by design, until Phase 2 adds relationship intelligence.