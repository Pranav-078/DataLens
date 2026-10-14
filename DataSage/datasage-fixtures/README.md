# DataSage Synthetic Fixture Repository

This repository is an independent, deterministic fixture suite for testing a
multi-table CSV data-quality and schema-intelligence platform. It does not
contain or run the DataSage frontend, backend, profiling engine, or evaluation
harness. The records are fully synthetic.

## Layout

```text
datasage-fixtures/
├── README.md
├── requirements.txt
├── .gitignore
├── scripts/
│   ├── generate_data.py
│   ├── validate_data.py
│   └── validate_ground_truth.py
├── data/
│   ├── v1_clean/
│   ├── v2_dirty/
│   └── v3_schema_drift/
└── ground_truth/
    ├── ground_truth.json
    └── ground_truth_schema.json
```

Each data directory contains the same seven CSV table names:
`customers`, `products`, `product_variants`, `orders`, `order_items`,
`tickets`, and `ticket_events`.

The repository uses only the Python standard library. From this directory:

```bash
python scripts/generate_data.py
python scripts/validate_data.py
python scripts/validate_ground_truth.py
```

`generate_data.py` replaces only the generated `data/` and `ground_truth/`
directories. It does not access any other project. It uses seed `20260918`,
stable formulas, stable row ordering, fixed historical dates, and fixed IDs;
re-running it produces byte-identical CSV and JSON files.

## Dataset versions

| Version | Purpose | Deliberate row changes |
|---|---|---:|
| `v1_clean` | Consistent baseline for profiling and relationship tests | customers 100, products 40, variants 80, orders 150, order items 337, tickets 100, events 300 |
| `v2_dirty` | Mostly clean data with targeted quality defects | customers 101 and events 301 because one complete customer and one complete event are duplicated; other tables retain baseline counts |
| `v3_schema_drift` | Newer, usable schema version based on `v1_clean` | Same row counts as clean; headers and selected value representations evolve |

The `NULL` token is the explicit null convention in this repository. A blank
CSV field is an empty string. This makes those two cases distinguishable to
ordinary CSV readers; the convention is recorded in `ground_truth.json`.

## Relational model

Primary keys:

| Table | Primary key |
|---|---|
| `customers` | `customer_id` |
| `products` | `product_id` |
| `product_variants` | `variant_id` |
| `orders` | `order_id` |
| `order_items` | `item_id` |
| `tickets` | `ticket_id` |
| `ticket_events` | `event_id` |

Foreign keys:

* `orders.customer_id` → `customers.customer_id`
* `order_items.order_id` → `orders.order_id`
* `order_items.product_id` → `products.product_id`
* `order_items.variant_id` → `product_variants.variant_id`
* `product_variants.product_id` → `products.product_id`
* `tickets.customer_id` → `customers.customer_id`
* `ticket_events.ticket_id` → `tickets.ticket_id`

Candidate keys are `customers.email`, `products.sku`, and
`product_variants.variant_sku`. They are unique in `v1_clean`. The dirty
version intentionally duplicates one customer email and one product SKU.

## Dirty defect catalog

Every entry below is represented in `ground_truth/ground_truth.json`, with a
version, table, column, stable row ID, physical row number, severity,
description, and `expected_detection: true`.

| Issue type | Affected location(s) |
|---|---|
| `null_value` | `customers.CUST-0010.email`; `products.PROD-0005.category`; `orders.ORD-0015.shipping_date`; `tickets.TICK-0020.priority` |
| `empty_string` | `customers.CUST-0030.phone` |
| `duplicate_record` | complete `customers.CUST-0020` row; complete `ticket_events.EVENT-0020` row |
| `duplicate_primary_key` | `customers.customer_id = CUST-0020` |
| `duplicate_candidate_key` | `customers.CUST-0021.email`; `products.PROD-0021.sku` |
| `invalid_numeric` | `products.PROD-0010.base_price = N/A`; `products.PROD-0011.base_price = -12.50`; `order_items.ITEM-0050.quantity = -3` |
| `mixed_type` | `product_variants.VAR-0010.is_active = yes`; `orders.ORD-0040.shipping_fee = free`; `order_items.ITEM-0060.line_total = oops` |
| `invalid_date` | `orders.ORD-0050.order_date`; `tickets.TICK-0030.opened_at` |
| `inconsistent_date_format` | `ticket_events.EVENT-0040.event_time` |
| `whitespace_inconsistency` | leading space in `products.PROD-0007.category` |
| `casing_inconsistency` | `orders.ORD-0041.status = delivered`; `orders.ORD-0042.status = DELIVERED` |
| `foreign_key_violation` | `orders.ORD-0060.customer_id = CUST-9999`; `ticket_events.EVENT-0070.ticket_id = TICK-9999` |
| `orphan_record` | `product_variants.VAR-0070`; `order_items.ITEM-0070` |
| `outlier` | `orders.ORD-0030.total_amount`; `order_items.ITEM-0080.quantity`; long `tickets.TICK-0040.description` |
| `missing_required_value` | blank `order_items.item_id` at the controlled ITEM-0090 row; blank `customers.customer_id` at the controlled CUST-0090 row |
| `value_consistency_violation` | `orders.ORD-0045.total_amount` does not equal subtotal + shipping + tax |
| `encoding_edge_case` | accented/non-English UTF-8 description in `products.PROD-0030` |

The duplicate-record and duplicate-primary-key entries for `CUST-0020`
intentionally describe two detection perspectives on the same physical
injection; they are not two additional rows.

## Schema-drift catalog

`v3_schema_drift` starts from the clean data and documents these exact
changes:

* `customers.full_name` is renamed to `customer_name`.
* `customers.loyalty_tier` is added.
* `customers.phone` is removed.
* `customers.is_active` changes from `true`/`false` text to `1`/`0` text.
* `products.category` changes `Home & Kitchen` to `Home & Living`.
* `orders.order_date` and `orders.shipping_date` use `MM/DD/YYYY` instead of
  ISO `YYYY-MM-DD`; the change is documented as `inconsistent_date_format`.
* `orders.fulfillment_center` is added.

The exact headers, counts, and changes are machine-readable in the ground
truth files. The drift version remains relationally usable; its order and
customer foreign-key values are unchanged.

## Validation behavior

`validate_data.py` checks:

* exact expected files and UTF-8 readability;
* headers, row counts, primary-key uniqueness, duplicate-key reporting,
  null counts, and inspectable parsed types;
* clean numeric/date values and all clean foreign-key relationships;
* every dirty defect in the catalog;
* the documented schema-drift headers and value changes.

`validate_ground_truth.py` checks:

* every table, column, and version reference;
* every physical row number and row ID;
* required defect fields, approved issue types, and unique defect IDs;
* expected row and column counts;
* primary-key, foreign-key, and candidate-key metadata.

The validators fail with a non-zero exit code and a specific message if a
ground-truth entry becomes stale or impossible.

## Limitations

These fixtures are intentionally small and synthetic. They are useful for
deterministic demonstrations, regression tests, relationship checks, and
defect-detection evaluation, but they do not model production distributions,
privacy-sensitive data, real customer behavior, or DataSage runtime behavior.
The suite does not repair dirty records or assert that a downstream platform
detects a defect; it proves that the fixture defect is present and documented.