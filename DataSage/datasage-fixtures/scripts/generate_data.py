#!/usr/bin/env python3
"""Generate deterministic synthetic relational fixtures for DataSage tests.

This repository is deliberately independent from the DataSage application.  It
creates three versions of the same synthetic domains:

* v1_clean: internally consistent baseline data
* v2_dirty: baseline data with documented, deterministic defects
* v3_schema_drift: a realistic schema evolution of the clean baseline

The only output written by this script is below the repository root.
"""

from __future__ import annotations

import copy
import csv
import json
import random
import shutil
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = ROOT / "data"
GROUND_TRUTH_ROOT = ROOT / "ground_truth"
SEED = 20260918
NULL_TOKEN = "NULL"

TABLE_ORDER = [
    "customers",
    "products",
    "product_variants",
    "orders",
    "order_items",
    "tickets",
    "ticket_events",
]

CLEAN_COLUMNS: dict[str, list[str]] = {
    "customers": [
        "customer_id",
        "full_name",
        "email",
        "phone",
        "signup_date",
        "country",
        "segment",
        "is_active",
    ],
    "products": [
        "product_id",
        "sku",
        "product_name",
        "category",
        "base_price",
        "currency",
        "status",
        "created_date",
        "description",
    ],
    "product_variants": [
        "variant_id",
        "product_id",
        "variant_sku",
        "option_name",
        "option_value",
        "price_adjustment",
        "stock_quantity",
        "is_active",
    ],
    "orders": [
        "order_id",
        "customer_id",
        "order_date",
        "shipping_date",
        "status",
        "payment_method",
        "shipping_country",
        "subtotal",
        "shipping_fee",
        "tax_amount",
        "total_amount",
    ],
    "order_items": [
        "item_id",
        "order_id",
        "product_id",
        "variant_id",
        "quantity",
        "unit_price",
        "line_total",
    ],
    "tickets": [
        "ticket_id",
        "customer_id",
        "opened_at",
        "priority",
        "status",
        "channel",
        "subject",
        "description",
        "assigned_team",
    ],
    "ticket_events": [
        "event_id",
        "ticket_id",
        "event_time",
        "event_type",
        "actor_role",
        "note",
    ],
}

PRIMARY_KEYS = {
    "customers": "customer_id",
    "products": "product_id",
    "product_variants": "variant_id",
    "orders": "order_id",
    "order_items": "item_id",
    "tickets": "ticket_id",
    "ticket_events": "event_id",
}

FOREIGN_KEYS = [
    {
        "from_table": "orders",
        "from_column": "customer_id",
        "to_table": "customers",
        "to_column": "customer_id",
    },
    {
        "from_table": "order_items",
        "from_column": "order_id",
        "to_table": "orders",
        "to_column": "order_id",
    },
    {
        "from_table": "order_items",
        "from_column": "product_id",
        "to_table": "products",
        "to_column": "product_id",
    },
    {
        "from_table": "order_items",
        "from_column": "variant_id",
        "to_table": "product_variants",
        "to_column": "variant_id",
    },
    {
        "from_table": "product_variants",
        "from_column": "product_id",
        "to_table": "products",
        "to_column": "product_id",
    },
    {
        "from_table": "tickets",
        "from_column": "customer_id",
        "to_table": "customers",
        "to_column": "customer_id",
    },
    {
        "from_table": "ticket_events",
        "from_column": "ticket_id",
        "to_table": "tickets",
        "to_column": "ticket_id",
    },
]

CANDIDATE_KEYS = {
    "customers": ["email"],
    "products": ["sku"],
    "product_variants": ["variant_sku"],
}


def money(value: Decimal) -> str:
    return f"{value.quantize(Decimal('0.01')):.2f}"


def iso_day(value: date) -> str:
    return value.isoformat()


def iso_timestamp(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%S")


def write_csv(path: Path, columns: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=columns,
            extrasaction="raise",
            lineterminator="\n",
        )
        writer.writeheader()
        for row in rows:
            writer.writerow({column: row.get(column, "") for column in columns})


def write_version(version: str, tables: dict[str, list[dict[str, str]]],
                  columns_by_table: dict[str, list[str]] | None = None) -> None:
    columns_by_table = columns_by_table or CLEAN_COLUMNS
    version_root = DATA_ROOT / version
    version_root.mkdir(parents=True, exist_ok=True)
    for table in TABLE_ORDER:
        write_csv(
            version_root / f"{table}.csv",
            columns_by_table[table],
            tables[table],
        )


def build_clean_data() -> dict[str, list[dict[str, str]]]:
    rng = random.Random(SEED)
    customers: list[dict[str, str]] = []
    countries = ["US", "CA", "GB", "DE", "AU", "SG"]
    segments = ["consumer", "business", "student", "premium"]
    first_names = ["Ari", "Bela", "Cora", "Dax", "Eli", "Faye", "Gio", "Hana"]
    last_names = ["Nolin", "Parker", "Quill", "Rao", "Sato", "Tarin", "Vega", "Wren"]
    start = date(2025, 1, 2)

    for index in range(1, 101):
        customer_id = f"CUST-{index:04d}"
        customers.append(
            {
                "customer_id": customer_id,
                "full_name": f"{first_names[(index - 1) % len(first_names)]} "
                f"{last_names[(index * 3) % len(last_names)]}",
                "email": f"user{index:04d}@example.test",
                "phone": f"+1-555-{1000 + index:04d}",
                "signup_date": iso_day(start + timedelta(days=(index * 3) % 300)),
                "country": countries[(index - 1) % len(countries)],
                "segment": segments[(index + 1) % len(segments)],
                "is_active": "true" if index % 11 != 0 else "false",
            }
        )

    categories = [
        "Electronics",
        "Home & Kitchen",
        "Apparel",
        "Books",
        "Sports",
        "Beauty",
    ]
    product_adjectives = ["Everyday", "Compact", "Classic", "Modern", "Essential"]
    products: list[dict[str, str]] = []
    for index in range(1, 41):
        category = categories[(index - 1) % len(categories)]
        price = Decimal("12.50") + Decimal((index * 17) % 900) / Decimal("10")
        products.append(
            {
                "product_id": f"PROD-{index:04d}",
                "sku": f"SKU-{index:04d}",
                "product_name": f"{product_adjectives[index % len(product_adjectives)]} "
                f"{category} Item {index:02d}",
                "category": category,
                "base_price": money(price),
                "currency": "USD",
                "status": "active" if index % 13 != 0 else "discontinued",
                "created_date": iso_day(date(2024, 6, 1) + timedelta(days=index * 4)),
                "description": f"Synthetic {category.lower()} product {index:02d}, "
                "created solely for deterministic fixture testing.",
            }
        )

    variants: list[dict[str, str]] = []
    variants_by_product: dict[str, list[dict[str, str]]] = {}
    variant_index = 1
    for product in products:
        product_variants: list[dict[str, str]] = []
        for option_name, option_value, adjustment in [
            ("size", "standard", Decimal("0.00")),
            ("size", "large", Decimal("4.50")),
        ]:
            variant = {
                "variant_id": f"VAR-{variant_index:04d}",
                "product_id": product["product_id"],
                "variant_sku": f"{product['sku']}-{option_value.upper()[:3]}",
                "option_name": option_name,
                "option_value": option_value,
                "price_adjustment": money(adjustment),
                "stock_quantity": str(30 + (variant_index * 7) % 170),
                "is_active": "true",
            }
            variants.append(variant)
            product_variants.append(variant)
            variant_index += 1
        variants_by_product[product["product_id"]] = product_variants

    payment_methods = ["card", "bank_transfer", "wallet", "invoice"]
    order_statuses = ["pending", "processing", "shipped", "delivered", "cancelled"]
    orders: list[dict[str, str]] = []
    order_items: list[dict[str, str]] = []
    item_index = 1
    customer_by_id = {row["customer_id"]: row for row in customers}
    product_by_id = {row["product_id"]: row for row in products}
    for order_index in range(1, 151):
        order_id = f"ORD-{order_index:04d}"
        customer_id = f"CUST-{((order_index * 7) % 100) + 1:04d}"
        order_date = date(2025, 2, 1) + timedelta(days=(order_index * 2) % 280)
        shipping_date = order_date + timedelta(days=2 + order_index % 4)
        item_count = 2 + (order_index % 4 == 0)
        subtotal = Decimal("0.00")
        for item_offset in range(item_count):
            product_index = ((order_index * 5 + item_offset * 11) % 40) + 1
            product_id = f"PROD-{product_index:04d}"
            variants_for_product = variants_by_product[product_id]
            variant = variants_for_product[(order_index + item_offset) % 2]
            quantity = 1 + ((order_index + item_offset) % 3)
            unit_price = Decimal(product_by_id[product_id]["base_price"]) + Decimal(
                variant["price_adjustment"]
            )
            line_total = unit_price * quantity
            order_items.append(
                {
                    "item_id": f"ITEM-{item_index:04d}",
                    "order_id": order_id,
                    "product_id": product_id,
                    "variant_id": variant["variant_id"],
                    "quantity": str(quantity),
                    "unit_price": money(unit_price),
                    "line_total": money(line_total),
                }
            )
            subtotal += line_total
            item_index += 1
        shipping_fee = Decimal("0.00") if subtotal >= Decimal("100.00") else Decimal("7.50")
        tax_amount = (subtotal * Decimal("0.08")).quantize(Decimal("0.01"))
        total = subtotal + shipping_fee + tax_amount
        orders.append(
            {
                "order_id": order_id,
                "customer_id": customer_id,
                "order_date": iso_day(order_date),
                "shipping_date": iso_day(shipping_date),
                "status": order_statuses[(order_index - 1) % len(order_statuses)],
                "payment_method": payment_methods[(order_index - 1) % len(payment_methods)],
                "shipping_country": customer_by_id[customer_id]["country"],
                "subtotal": money(subtotal),
                "shipping_fee": money(shipping_fee),
                "tax_amount": money(tax_amount),
                "total_amount": money(total),
            }
        )

    ticket_statuses = ["open", "pending", "resolved", "closed"]
    priorities = ["low", "medium", "high", "urgent"]
    channels = ["email", "chat", "phone", "web"]
    teams = ["billing", "technical", "orders", "accounts"]
    tickets: list[dict[str, str]] = []
    for index in range(1, 101):
        ticket_id = f"TICK-{index:04d}"
        opened = datetime(2025, 3, 1, 8, 0, 0) + timedelta(
            days=index % 90, hours=index % 8
        )
        tickets.append(
            {
                "ticket_id": ticket_id,
                "customer_id": f"CUST-{((index * 9) % 100) + 1:04d}",
                "opened_at": iso_timestamp(opened),
                "priority": priorities[(index - 1) % len(priorities)],
                "status": ticket_statuses[(index + 1) % len(ticket_statuses)],
                "channel": channels[(index - 1) % len(channels)],
                "subject": f"Synthetic support request {index:03d}",
                "description": f"Fixture customer reports a routine issue for ticket {ticket_id}.",
                "assigned_team": teams[(index - 1) % len(teams)],
            }
        )

    ticket_events: list[dict[str, str]] = []
    event_index = 1
    event_types = ["created", "assigned", "status_change"]
    actor_roles = ["customer", "agent", "system"]
    for ticket_index in range(1, 101):
        ticket_id = f"TICK-{ticket_index:04d}"
        opened = datetime(2025, 3, 1, 8, 0, 0) + timedelta(
            days=ticket_index % 90, hours=ticket_index % 8
        )
        for offset in range(3):
            event_time = opened + timedelta(hours=offset * 5 + 1)
            ticket_events.append(
                {
                    "event_id": f"EVENT-{event_index:04d}",
                    "ticket_id": ticket_id,
                    "event_time": iso_timestamp(event_time),
                    "event_type": event_types[offset],
                    "actor_role": actor_roles[offset],
                    "note": f"Synthetic event {event_index:03d} for {ticket_id}.",
                }
            )
            event_index += 1

    # The seed is intentionally constructed even though the fixture formulas
    # below are deterministic without sampling.  Keeping it in the generator
    # makes the reproducibility contract explicit and leaves room for adding
    # seeded choices without introducing uncontrolled randomness.
    _ = rng
    return {
        "customers": customers,
        "products": products,
        "product_variants": variants,
        "orders": orders,
        "order_items": order_items,
        "tickets": tickets,
        "ticket_events": ticket_events,
    }


def row_number(rows: list[dict[str, str]], key: str, value: str,
               occurrence: int = 1) -> int:
    seen = 0
    for index, row in enumerate(rows, start=1):
        if row.get(key) == value:
            seen += 1
            if seen == occurrence:
                return index
    raise ValueError(f"Could not find {key}={value!r}")


def dirty_defect(defect_id: str, table: str, issue_type: str, column: str,
                 row_ids: list[str], row_numbers: list[int], severity: str,
                 description: str, **extra: Any) -> dict[str, Any]:
    result: dict[str, Any] = {
        "defect_id": defect_id,
        "version": "v2_dirty",
        "table": table,
        "issue_type": issue_type,
        "column": column,
        "row_ids": row_ids,
        "row_numbers": row_numbers,
        "severity": severity,
        "description": description,
        "expected_detection": True,
    }
    result.update(extra)
    return result


def build_dirty_data(clean: dict[str, list[dict[str, str]]]) -> tuple[
    dict[str, list[dict[str, str]]], list[dict[str, Any]]
]:
    dirty = copy.deepcopy(clean)
    defects: list[dict[str, Any]] = []

    def set_value(table: str, key: str, value: str, column: str, issue: str,
                  description: str, severity: str = "medium", **extra: Any) -> None:
        rows = dirty[table]
        index = row_number(rows, PRIMARY_KEYS[table], key)
        rows[index - 1][column] = value
        defects.append(
            dirty_defect(
                f"DIRTY-{len(defects) + 1:03d}",
                table,
                issue,
                column,
                [key],
                [index],
                severity,
                description,
                **extra,
            )
        )

    set_value(
        "customers", "CUST-0010", NULL_TOKEN, "email", "null_value",
        "Customer email uses the repository NULL sentinel.", "medium",
    )
    set_value(
        "customers", "CUST-0030", "", "phone", "empty_string",
        "Phone is intentionally an empty CSV field, distinct from NULL.",
        "low",
    )
    set_value(
        "products", "PROD-0005", NULL_TOKEN, "category", "null_value",
        "Product category is intentionally null.", "medium",
    )
    set_value(
        "products", "PROD-0007", " Electronics", "category",
        "whitespace_inconsistency", "Category has an intentional leading space.",
        "low",
    )
    set_value(
        "products", "PROD-0010", "N/A", "base_price", "invalid_numeric",
        "Base price is a non-numeric value.", "high",
    )
    set_value(
        "products", "PROD-0011", "-12.50", "base_price", "invalid_numeric",
        "Base price is negative although prices must be non-negative.", "high",
    )
    set_value(
        "products", "PROD-0030",
        "Café moka – tamaño mediano / thé vert",
        "description",
        "encoding_edge_case",
        "Description contains deterministic non-ASCII UTF-8 text.",
        "low",
    )
    set_value(
        "products", "PROD-0021", "SKU-0001", "sku",
        "duplicate_candidate_key", "SKU duplicates product PROD-0001.",
        "medium",
    )
    set_value(
        "product_variants", "VAR-0010", "yes", "is_active", "mixed_type",
        "Boolean-like field contains an inconsistent representation.", "medium",
    )
    set_value(
        "product_variants", "VAR-0070", "PROD-9999", "product_id",
        "orphan_record", "Variant references a product that does not exist.",
        "high",
    )
    set_value(
        "orders", "ORD-0015", NULL_TOKEN, "shipping_date", "null_value",
        "Shipping date is intentionally null.", "medium",
    )
    set_value(
        "orders", "ORD-0030", "999999.99", "total_amount", "outlier",
        "Order total is an intentionally extreme amount.", "high",
    )
    set_value(
        "orders", "ORD-0040", "free", "shipping_fee", "mixed_type",
        "Numeric shipping fee contains text.", "high",
    )
    set_value(
        "orders", "ORD-0041", "delivered", "status", "casing_inconsistency",
        "Status uses lowercase instead of the canonical title case.", "low",
        canonical_value="Delivered",
    )
    set_value(
        "orders", "ORD-0042", "DELIVERED", "status", "casing_inconsistency",
        "Status uses uppercase instead of the canonical title case.", "low",
        canonical_value="Delivered",
    )
    set_value(
        "orders", "ORD-0045", "1.00", "total_amount",
        "value_consistency_violation",
        "Total does not equal subtotal plus shipping fee plus tax.",
        "high",
    )
    set_value(
        "orders", "ORD-0050", "not-a-date", "order_date", "invalid_date",
        "Order date is malformed.", "high",
    )
    set_value(
        "orders", "ORD-0060", "CUST-9999", "customer_id",
        "foreign_key_violation",
        "Order references a nonexistent customer.", "high",
    )
    set_value(
        "order_items", "ITEM-0050", "-3", "quantity", "invalid_numeric",
        "Quantity is negative although quantities must be positive.", "high",
    )
    set_value(
        "order_items", "ITEM-0060", "oops", "line_total", "mixed_type",
        "Line total is a non-numeric value.", "high",
    )
    set_value(
        "order_items", "ITEM-0070", "ORD-9999", "order_id", "orphan_record",
        "Order item has no parent order.", "high",
    )
    set_value(
        "order_items", "ITEM-0080", "999", "quantity", "outlier",
        "Quantity is intentionally abnormally high.", "high",
    )
    set_value(
        "order_items", "ITEM-0090", "", "item_id", "missing_required_value",
        "Required item identifier is intentionally empty.", "high",
    )
    # The physical row is now addressable by an empty primary-key value, not
    # by the pre-mutation identifier used to locate it.
    defects[-1]["row_ids"] = [""]
    set_value(
        "tickets", "TICK-0020", NULL_TOKEN, "priority", "null_value",
        "Ticket priority is intentionally null.", "medium",
    )
    set_value(
        "tickets", "TICK-0030", "2025/04/31 10:15:00", "opened_at",
        "invalid_date", "Opened timestamp is impossible and uses a malformed date.",
        "high",
    )
    long_description = "Synthetic escalation detail " * 100
    set_value(
        "tickets", "TICK-0040", long_description, "description", "outlier",
        "Description is intentionally much longer than normal fixture text.",
        "low",
    )
    set_value(
        "customers", "CUST-0021", "user0001@example.test", "email",
        "duplicate_candidate_key", "Email duplicates customer CUST-0001.",
        "medium",
    )
    set_value(
        "ticket_events", "EVENT-0040", "03/18/2025 09:45", "event_time",
        "inconsistent_date_format",
        "Event timestamp uses a non-ISO date representation.", "medium",
    )
    set_value(
        "ticket_events", "EVENT-0070", "TICK-9999", "ticket_id",
        "foreign_key_violation",
        "Ticket event references a nonexistent ticket.", "high",
    )

    # A complete duplicate creates both a duplicate-record defect and an
    # explicit duplicate-primary-key defect.  The row numbers distinguish the
    # two physical CSV rows even though their IDs are equal.
    duplicate_customer = copy.deepcopy(
        dirty["customers"][row_number(dirty["customers"], "customer_id", "CUST-0020") - 1]
    )
    dirty["customers"].append(duplicate_customer)
    original_customer_row = row_number(dirty["customers"], "customer_id", "CUST-0020", 1)
    duplicate_customer_row = row_number(dirty["customers"], "customer_id", "CUST-0020", 2)
    defects.append(
        dirty_defect(
            f"DIRTY-{len(defects) + 1:03d}",
            "customers",
            "duplicate_record",
            "customer_id",
            ["CUST-0020"],
            [original_customer_row, duplicate_customer_row],
            "high",
            "Complete customer record is duplicated.",
        )
    )
    defects.append(
        dirty_defect(
            f"DIRTY-{len(defects) + 1:03d}",
            "customers",
            "duplicate_primary_key",
            "customer_id",
            ["CUST-0020"],
            [original_customer_row, duplicate_customer_row],
            "high",
            "Customer primary key is duplicated by the complete duplicate row.",
        )
    )

    duplicate_event = copy.deepcopy(
        dirty["ticket_events"][row_number(dirty["ticket_events"], "event_id", "EVENT-0020") - 1]
    )
    dirty["ticket_events"].append(duplicate_event)
    original_event_row = row_number(dirty["ticket_events"], "event_id", "EVENT-0020", 1)
    duplicate_event_row = row_number(dirty["ticket_events"], "event_id", "EVENT-0020", 2)
    defects.append(
        dirty_defect(
            f"DIRTY-{len(defects) + 1:03d}",
            "ticket_events",
            "duplicate_record",
            "event_id",
            ["EVENT-0020"],
            [original_event_row, duplicate_event_row],
            "medium",
            "Complete ticket-event record is duplicated.",
        )
    )

    # Missing required identifier is represented by an empty field.  It is
    # located by its physical row number because its identifier is now blank.
    # Use the original ninth-decade row by stable position; this avoids making
    # a missing identifier look like a real ID.
    target_missing_index = 89
    dirty["customers"][target_missing_index]["customer_id"] = ""
    missing_customer_row = target_missing_index + 1
    defects.append(
        dirty_defect(
            f"DIRTY-{len(defects) + 1:03d}",
            "customers",
            "missing_required_value",
            "customer_id",
            [""],
            [missing_customer_row],
            "high",
            "Required customer identifier is intentionally empty.",
        )
    )

    # Reorder the missing-ID defect to remain in the natural mutation order is
    # unnecessary; IDs are assigned sequentially and all row locations are
    # explicit.  The output ordering is stable.
    return dirty, defects


def build_schema_drift(clean: dict[str, list[dict[str, str]]]) -> tuple[
    dict[str, list[dict[str, str]]], dict[str, list[str]], list[dict[str, Any]]
]:
    drift = copy.deepcopy(clean)
    columns = copy.deepcopy(CLEAN_COLUMNS)
    changes: list[dict[str, Any]] = []

    for row in drift["customers"]:
        row["customer_name"] = row.pop("full_name")
        row["loyalty_tier"] = (
            "gold" if row["customer_id"].endswith(("1", "2", "3")) else "standard"
        )
        row.pop("phone")
        row["is_active"] = "1" if row["is_active"] == "true" else "0"
    columns["customers"] = [
        "customer_id",
        "customer_name",
        "email",
        "signup_date",
        "country",
        "segment",
        "is_active",
        "loyalty_tier",
    ]
    changes.extend(
        [
            {
                "defect_id": "SCHEMA-001",
                "version": "v3_schema_drift",
                "table": "customers",
                "issue_type": "schema_renamed_column",
                "column": "full_name",
                "new_column": "customer_name",
                "row_ids": [],
                "severity": "medium",
                "expected_detection": True,
                "description": "full_name was renamed to customer_name.",
            },
            {
                "defect_id": "SCHEMA-002",
                "version": "v3_schema_drift",
                "table": "customers",
                "issue_type": "schema_added_column",
                "column": "loyalty_tier",
                "row_ids": [],
                "severity": "low",
                "expected_detection": True,
                "description": "loyalty_tier was added for customer segmentation.",
            },
            {
                "defect_id": "SCHEMA-003",
                "version": "v3_schema_drift",
                "table": "customers",
                "issue_type": "schema_removed_column",
                "column": "phone",
                "row_ids": [],
                "severity": "medium",
                "expected_detection": True,
                "description": "phone was removed from the newer customer export.",
            },
            {
                "defect_id": "SCHEMA-004",
                "version": "v3_schema_drift",
                "table": "customers",
                "issue_type": "schema_type_change",
                "column": "is_active",
                "from_type": "boolean_text",
                "to_type": "integer_text",
                "row_ids": [],
                "severity": "medium",
                "expected_detection": True,
                "description": "is_active changed from true/false text to 1/0 text.",
            },
        ]
    )

    for row in drift["products"]:
        if row["category"] == "Home & Kitchen":
            row["category"] = "Home & Living"
    changes.append(
        {
            "defect_id": "SCHEMA-005",
            "version": "v3_schema_drift",
            "table": "products",
            "issue_type": "category_drift",
            "column": "category",
            "old_values": ["Home & Kitchen"],
            "new_values": ["Home & Living"],
            "row_ids": [],
            "severity": "medium",
            "expected_detection": True,
            "description": "Home & Kitchen was renamed to Home & Living.",
        }
    )

    for row in drift["orders"]:
        row["order_date"] = datetime.strptime(row["order_date"], "%Y-%m-%d").strftime(
            "%m/%d/%Y"
        )
        row["shipping_date"] = datetime.strptime(
            row["shipping_date"], "%Y-%m-%d"
        ).strftime("%m/%d/%Y")
        row["fulfillment_center"] = f"FC-{(int(row['order_id'][-4:]) % 4) + 1:02d}"
    columns["orders"] = CLEAN_COLUMNS["orders"] + ["fulfillment_center"]
    changes.extend(
        [
            {
                "defect_id": "SCHEMA-006",
                "version": "v3_schema_drift",
                "table": "orders",
                "issue_type": "inconsistent_date_format",
                "column": "order_date",
                "row_ids": [],
                "from_format": "YYYY-MM-DD",
                "to_format": "MM/DD/YYYY",
                "description": "Order dates use a US slash-separated representation.",
                "severity": "medium",
                "expected_detection": True,
            },
            {
                "defect_id": "SCHEMA-007",
                "version": "v3_schema_drift",
                "table": "orders",
                "issue_type": "schema_added_column",
                "column": "fulfillment_center",
                "row_ids": [],
                "severity": "low",
                "expected_detection": True,
                "description": "fulfillment_center was added to order exports.",
            },
        ]
    )
    return drift, columns, changes


def build_ground_truth(
    clean: dict[str, list[dict[str, str]]],
    dirty: dict[str, list[dict[str, str]]],
    drift: dict[str, list[dict[str, str]]],
    drift_columns: dict[str, list[str]],
    defects: list[dict[str, Any]],
    schema_changes: list[dict[str, Any]],
) -> dict[str, Any]:
    versions = {
        "v1_clean": clean,
        "v2_dirty": dirty,
        "v3_schema_drift": drift,
    }
    columns_by_version = {
        "v1_clean": CLEAN_COLUMNS,
        "v2_dirty": CLEAN_COLUMNS,
        "v3_schema_drift": drift_columns,
    }
    expected_row_counts = {
        version: {table: len(tables[table]) for table in TABLE_ORDER}
        for version, tables in versions.items()
    }
    expected_column_counts = {
        version: {
            table: len(columns_by_version[version][table])
            for table in TABLE_ORDER
        }
        for version in versions
    }
    all_defects = defects + schema_changes
    return {
        "dataset_version": "fixture-suite-1.0",
        "generator_seed": SEED,
        "null_representation": {
            "token": NULL_TOKEN,
            "description": "The literal NULL token represents a null value; a blank field represents an empty string.",
        },
        "tables": TABLE_ORDER,
        "primary_keys": PRIMARY_KEYS,
        "foreign_keys": FOREIGN_KEYS,
        "candidate_keys": CANDIDATE_KEYS,
        "expected_row_counts": expected_row_counts,
        "expected_column_counts": expected_column_counts,
        "columns": columns_by_version,
        "schema_changes": schema_changes,
        "defects": all_defects,
        "limitations": [
            "The records are synthetic and are not representative of production distributions.",
            "The NULL token is an explicit fixture convention because blank and quoted-empty CSV fields otherwise collapse when parsed by common CSV readers.",
            "No repair suggestions or DataSage profiling behavior is included.",
        ],
    }


def build_ground_truth_schema() -> dict[str, Any]:
    issue_types = [
        "null_value",
        "empty_string",
        "duplicate_record",
        "duplicate_primary_key",
        "duplicate_candidate_key",
        "invalid_numeric",
        "mixed_type",
        "invalid_date",
        "inconsistent_date_format",
        "whitespace_inconsistency",
        "casing_inconsistency",
        "foreign_key_violation",
        "orphan_record",
        "outlier",
        "missing_required_value",
        "value_consistency_violation",
        "encoding_edge_case",
        "schema_added_column",
        "schema_removed_column",
        "schema_renamed_column",
        "schema_type_change",
        "category_drift",
    ]
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "DataSage synthetic fixture ground truth",
        "type": "object",
        "required": [
            "dataset_version",
            "tables",
            "primary_keys",
            "foreign_keys",
            "candidate_keys",
            "expected_row_counts",
            "expected_column_counts",
            "defects",
        ],
        "properties": {
            "dataset_version": {"type": "string"},
            "tables": {"type": "array", "items": {"type": "string"}},
            "primary_keys": {"type": "object"},
            "foreign_keys": {"type": "array"},
            "candidate_keys": {"type": "object"},
            "expected_row_counts": {"type": "object"},
            "expected_column_counts": {"type": "object"},
            "defects": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": [
                        "defect_id",
                        "version",
                        "table",
                        "issue_type",
                        "column",
                        "row_ids",
                        "severity",
                        "description",
                        "expected_detection",
                    ],
                },
            },
        },
        "allowed_issue_types": issue_types,
        "row_reference_convention": "row_numbers are 1-based data-row numbers excluding the CSV header.",
    }


def main() -> None:
    clean = build_clean_data()
    dirty, defects = build_dirty_data(clean)
    drift, drift_columns, schema_changes = build_schema_drift(clean)

    if DATA_ROOT.exists():
        shutil.rmtree(DATA_ROOT)
    if GROUND_TRUTH_ROOT.exists():
        shutil.rmtree(GROUND_TRUTH_ROOT)

    write_version("v1_clean", clean)
    write_version("v2_dirty", dirty)
    write_version("v3_schema_drift", drift, drift_columns)

    ground_truth = build_ground_truth(
        clean, dirty, drift, drift_columns, defects, schema_changes
    )
    GROUND_TRUTH_ROOT.mkdir(parents=True, exist_ok=True)
    (GROUND_TRUTH_ROOT / "ground_truth.json").write_text(
        json.dumps(ground_truth, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    (GROUND_TRUTH_ROOT / "ground_truth_schema.json").write_text(
        json.dumps(build_ground_truth_schema(), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Generated fixtures in {ROOT}")
    for version in ("v1_clean", "v2_dirty", "v3_schema_drift"):
        print(
            version,
            ", ".join(
                f"{table}={len((clean, dirty, drift)[('v1_clean', 'v2_dirty', 'v3_schema_drift').index(version)][table])}"
                for table in TABLE_ORDER
            ),
        )
    print(f"Ground-truth defects: {len(ground_truth['defects'])}")


if __name__ == "__main__":
    main()