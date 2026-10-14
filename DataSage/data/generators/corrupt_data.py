"""
Reads data/clean/*.csv (produced by make_clean_data.py) and writes a
corrupted copy of each into data/corrupted/, injecting a fixed set of known
defects. Every injection is recorded in data/corrupted/ground_truth.json,
keyed by row_uid — NOT by row index, since row order/count can shift.

This manifest is the entire point of the evaluation harness: a detector's
precision/recall can only be measured against defects whose location is
known exactly, which requires the row_uid to survive unchanged from
make_clean_data.py through this script.

Determinism: same EVAL_RANDOM_SEED as make_clean_data.py (default 42) drives
every corruption choice, via its own seeded Random instance offset from the
generator's, so re-running produces byte-identical corrupted output and an
identical manifest.
"""

from __future__ import annotations

import csv
import json
import os
import random
from pathlib import Path
from typing import Any

SEED = int(os.environ.get("EVAL_RANDOM_SEED", "42"))
CLEAN_DIR = Path(__file__).resolve().parent.parent / "clean"
CORRUPTED_DIR = Path(__file__).resolve().parent.parent / "corrupted"

# Offset from make_clean_data.py's seed so corruption choices are
# independent of generation choices, while still fully deterministic.
rng = random.Random(SEED + 1)


def read_csv(path: Path) -> list[dict[str, str]]:
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_csv(rows: list[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = list(rows[0].keys())
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


class GroundTruth:
    """Accumulates one entry per injected defect. See
    evaluation/ground_truth.schema.json for the exact shape this produces."""

    def __init__(self) -> None:
        self.entries: list[dict[str, Any]] = []

    def add(
        self,
        *,
        table: str,
        row_uid: str,
        column: str | None,
        defect_type: str,
        original_value: Any,
        corrupted_value: Any,
    ) -> None:
        self.entries.append(
            {
                "table": table,
                "row_uid": row_uid,
                "column": column,
                "defect_type": defect_type,
                "original_value": original_value,
                "corrupted_value": corrupted_value,
            }
        )

    def write(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"seed": SEED, "defects": self.entries}, f, indent=2)


def corrupt_customers(rows: list[dict], gt: GroundTruth) -> list[dict]:
    rows = [dict(r) for r in rows]  # don't mutate the caller's list of dicts

    # 1. Missing emails: blank out ~5% of emails.
    for r in rng.sample(rows, max(1, len(rows) // 20)):
        gt.add(
            table="customers",
            row_uid=r["row_uid"],
            column="email",
            defect_type="missing_value",
            original_value=r["email"],
            corrupted_value="",
        )
        r["email"] = ""

    # 2. Invalid email strings: mangle ~5% of the (still-present) emails.
    candidates = [r for r in rows if r["email"]]
    for r in rng.sample(candidates, max(1, len(candidates) // 20)):
        original = r["email"]
        corrupted = original.replace("@", "_at_")  # no longer a valid email shape
        gt.add(
            table="customers",
            row_uid=r["row_uid"],
            column="email",
            defect_type="invalid_email_format",
            original_value=original,
            corrupted_value=corrupted,
        )
        r["email"] = corrupted

    # 3. Duplicate customer_id: pick 3 rows, force their customer_id to
    # collide with another row's customer_id (a real, referenceable dupe).
    dupe_targets = rng.sample(rows, 3)
    for r in dupe_targets:
        other = rng.choice([x for x in rows if x["customer_id"] != r["customer_id"]])
        gt.add(
            table="customers",
            row_uid=r["row_uid"],
            column="customer_id",
            defect_type="duplicate_id",
            original_value=r["customer_id"],
            corrupted_value=other["customer_id"],
        )
        r["customer_id"] = other["customer_id"]

    # 4. Invalid dates: corrupt ~3% of signup_date into an implausible date.
    for r in rng.sample(rows, max(1, len(rows) // 33)):
        original = r["signup_date"]
        corrupted = "2099-13-45"  # not a real calendar date at all
        gt.add(
            table="customers",
            row_uid=r["row_uid"],
            column="signup_date",
            defect_type="invalid_date_format",
            original_value=original,
            corrupted_value=corrupted,
        )
        r["signup_date"] = corrupted

    return rows


def corrupt_orders(rows: list[dict], valid_customer_ids: set[str], gt: GroundTruth) -> list[dict]:
    rows = [dict(r) for r in rows]

    # 5. Orphan customer_id: point ~4% of orders at a customer_id that does
    # not exist anywhere in customers.csv.
    fake_customer_id = str(max(int(c) for c in valid_customer_ids) + 9999)
    for r in rng.sample(rows, max(1, len(rows) // 25)):
        gt.add(
            table="orders",
            row_uid=r["row_uid"],
            column="customer_id",
            defect_type="orphan_foreign_key",
            original_value=r["customer_id"],
            corrupted_value=fake_customer_id,
        )
        r["customer_id"] = fake_customer_id

    # 6. Negative quantities: ~3% of orders get a negative quantity.
    for r in rng.sample(rows, max(1, len(rows) // 33)):
        original = r["quantity"]
        corrupted = str(-abs(int(original)) - 1)
        gt.add(
            table="orders",
            row_uid=r["row_uid"],
            column="quantity",
            defect_type="negative_value",
            original_value=original,
            corrupted_value=corrupted,
        )
        r["quantity"] = corrupted

    # 7. Duplicate orders: append 5 exact duplicate rows (of already-corrupted
    # rows is fine — a duplicate is a duplicate regardless of content).
    dupes = [dict(r) for r in rng.sample(rows, 5)]
    for d in dupes:
        gt.add(
            table="orders",
            row_uid=d["row_uid"],
            column=None,
            defect_type="duplicate_row",
            original_value=None,
            corrupted_value=None,
        )
    rows = rows + dupes

    # 8. Invalid category-adjacent value: corrupt ~3% of status into a
    # value outside the known ORDER_STATUSES set.
    for r in rng.sample(rows, max(1, len(rows) // 33)):
        original = r["status"]
        corrupted = "Shippd"  # a typo'd near-neighbor of "shipped"
        gt.add(
            table="orders",
            row_uid=r["row_uid"],
            column="status",
            defect_type="rare_category_likely_typo",
            original_value=original,
            corrupted_value=corrupted,
        )
        r["status"] = corrupted

    # 9. Outlier amounts: ~1% of orders get an implausibly large total_amount.
    for r in rng.sample(rows, max(1, len(rows) // 100)):
        original = r["total_amount"]
        corrupted = str(round(float(original) * 500, 2))
        gt.add(
            table="orders",
            row_uid=r["row_uid"],
            column="total_amount",
            defect_type="statistical_outlier",
            original_value=original,
            corrupted_value=corrupted,
        )
        r["total_amount"] = corrupted

    return rows


def main() -> None:
    customers = read_csv(CLEAN_DIR / "customers.csv")
    products = read_csv(CLEAN_DIR / "products.csv")
    orders = read_csv(CLEAN_DIR / "orders.csv")
    payments = read_csv(CLEAN_DIR / "payments.csv")

    gt = GroundTruth()

    valid_customer_ids = {c["customer_id"] for c in customers}
    corrupted_customers = corrupt_customers(customers, gt)
    corrupted_orders = corrupt_orders(orders, valid_customer_ids, gt)

    write_csv(corrupted_customers, CORRUPTED_DIR / "customers.csv")
    write_csv(products, CORRUPTED_DIR / "products.csv")  # untouched, deliberately
    write_csv(corrupted_orders, CORRUPTED_DIR / "orders.csv")
    write_csv(payments, CORRUPTED_DIR / "payments.csv")  # untouched, deliberately

    gt.write(CORRUPTED_DIR / "ground_truth.json")

    by_type: dict[str, int] = {}
    for entry in gt.entries:
        by_type[entry["defect_type"]] = by_type.get(entry["defect_type"], 0) + 1

    print(f"Corrupted dataset written to {CORRUPTED_DIR} (seed={SEED})")
    print(f"Total injected defects: {len(gt.entries)}")
    for defect_type, count in sorted(by_type.items()):
        print(f"  {defect_type}: {count}")


if __name__ == "__main__":
    main()
