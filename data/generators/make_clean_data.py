"""
Generates a clean, related, deterministic dataset: customers, orders,
products, payments. Every row carries a `row_uid` — a stable identifier
that survives into the corrupted version (corrupt_data.py) unchanged.

That stability is what makes the evaluation harness possible: a corruption
script that injects "make row X's email invalid" can name row X by its
row_uid, and detector_eval.py can then check "did a detector flag row_uid X
for an email issue" as a precise, row-level comparison — not a fuzzy count
comparison. Without a stable ID surviving both generation and corruption,
there is no way to grade a detector's precision/recall at the row level.

Determinism: every random choice is drawn from a single seeded Random
instance (EVAL_RANDOM_SEED, default 42), so re-running this script produces
byte-identical output every time — a requirement for the evaluation
harness to produce comparable results across runs.
"""

from __future__ import annotations

import csv
import os
import random
import uuid
from datetime import date, timedelta
from pathlib import Path

SEED = int(os.environ.get("EVAL_RANDOM_SEED", "42"))
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "clean"

N_CUSTOMERS = 200
N_PRODUCTS = 30
N_ORDERS = 500
N_PAYMENTS = 480  # deliberately fewer than orders: some orders are unpaid, not a defect

COUNTRIES = ["US", "CA", "GB", "DE", "FR", "IN", "AU"]
CATEGORIES = ["electronics", "home", "clothing", "toys", "books"]
ORDER_STATUSES = ["pending", "shipped", "delivered", "cancelled"]
PAYMENT_STATUSES = ["completed", "pending", "refunded"]

rng = random.Random(SEED)


def stable_uid(prefix: str, index: int) -> str:
    """
    Deterministic per-row UID: derived from the seed + prefix + index via
    uuid5 (name-based, not random), so the SAME seed always produces the
    SAME row_uid for the same logical row — required for reproducibility.
    """
    namespace = uuid.UUID("12345678-1234-5678-1234-567812345678")
    return str(uuid.uuid5(namespace, f"{SEED}:{prefix}:{index}"))


def random_date(start: date, end: date) -> date:
    delta_days = (end - start).days
    return start + timedelta(days=rng.randint(0, delta_days))


def generate_customers() -> list[dict]:
    rows = []
    for i in range(N_CUSTOMERS):
        first = rng.choice(["Ann", "Bo", "Cara", "Dan", "Eve", "Finn", "Gia", "Hugo"])
        last = rng.choice(["Smith", "Lee", "Patel", "Garcia", "Kim", "Muller"])
        rows.append(
            {
                "row_uid": stable_uid("customers", i),
                "customer_id": 1000 + i,
                "name": f"{first} {last}",
                "email": f"{first.lower()}.{last.lower()}{i}@example.com",
                "signup_date": random_date(date(2023, 1, 1), date(2025, 6, 1)).isoformat(),
                "country": rng.choice(COUNTRIES),
            }
        )
    return rows


def generate_products() -> list[dict]:
    rows = []
    for i in range(N_PRODUCTS):
        rows.append(
            {
                "row_uid": stable_uid("products", i),
                "product_id": 5000 + i,
                "product_name": f"Product {i:03d}",
                "category": rng.choice(CATEGORIES),
                "price": round(rng.uniform(5, 500), 2),
            }
        )
    return rows


def generate_orders(customer_ids: list[int], product_ids: list[int]) -> list[dict]:
    rows = []
    for i in range(N_ORDERS):
        rows.append(
            {
                "row_uid": stable_uid("orders", i),
                "order_id": 9000 + i,
                "customer_id": rng.choice(customer_ids),
                "product_id": rng.choice(product_ids),
                "order_date": random_date(date(2024, 1, 1), date(2025, 9, 1)).isoformat(),
                "quantity": rng.randint(1, 5),
                "total_amount": round(rng.uniform(10, 800), 2),
                "status": rng.choice(ORDER_STATUSES),
            }
        )
    return rows


def generate_payments(order_ids: list[int]) -> list[dict]:
    rows = []
    payable_orders = rng.sample(order_ids, N_PAYMENTS)
    for i, order_id in enumerate(payable_orders):
        rows.append(
            {
                "row_uid": stable_uid("payments", i),
                "payment_id": 7000 + i,
                "order_id": order_id,
                "payment_date": random_date(date(2024, 1, 2), date(2025, 9, 5)).isoformat(),
                "amount": round(rng.uniform(10, 800), 2),
                "payment_status": rng.choice(PAYMENT_STATUSES),
            }
        )
    return rows


def write_csv(rows: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    customers = generate_customers()
    products = generate_products()
    orders = generate_orders(
        customer_ids=[c["customer_id"] for c in customers],
        product_ids=[p["product_id"] for p in products],
    )
    payments = generate_payments(order_ids=[o["order_id"] for o in orders])

    write_csv(customers, OUTPUT_DIR / "customers.csv")
    write_csv(products, OUTPUT_DIR / "products.csv")
    write_csv(orders, OUTPUT_DIR / "orders.csv")
    write_csv(payments, OUTPUT_DIR / "payments.csv")

    print(f"Generated clean dataset (seed={SEED}) into {OUTPUT_DIR}")
    print(f"  customers: {len(customers)} rows")
    print(f"  products:  {len(products)} rows")
    print(f"  orders:    {len(orders)} rows")
    print(f"  payments:  {len(payments)} rows")


if __name__ == "__main__":
    main()
