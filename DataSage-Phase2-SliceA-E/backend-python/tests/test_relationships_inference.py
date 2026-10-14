"""
Tests for app/relationships/inference.py.

Synthetic fixtures only — the authoritative datasage-fixtures repository is
never touched here, consistent with the Phase 2 requirement that unit
tests use small, purpose-built data. Where realistic Phase 1 ColumnProfile
stats are needed, they're produced by actually running the real, unmodified
DataProfiler() engine over a small synthetic DataFrame, rather than
hand-constructing ColumnProfile objects — this exercises the real
integration seam, not just a mock of it.
"""

import pandas as pd
import pytest

# Must be imported before anything under datasage_profiler.* — importing
# this module is what patches sys.path to make that package resolvable
# (see app/_vendor_path.py's docstring). Same ordering requirement as the
# existing tests/test_phase1_adapter.py.
from app.relationships.inference import (
    infer_relationships,
    name_similarity,
    type_exactness,
    _is_parent_candidate,
    _compute_containment,
    _normalize_token,
    CONFIDENCE_WEIGHT_CONTAINMENT,
    CONFIDENCE_WEIGHT_NAME_SIMILARITY,
    CONFIDENCE_WEIGHT_TYPE_EXACTNESS,
    CONFIDENCE_WEIGHT_NULL_RATE,
    CONFIDENCE_BAND_HIGH_MIN,
    CONFIDENCE_BAND_MEDIUM_MIN,
    MIN_CONTAINMENT,
    MIN_CONFIDENCE_TO_REPORT,
    MAX_ORPHAN_EXAMPLES,
)

from datasage_profiler.engine import DataProfiler


def profile(tables: dict[str, pd.DataFrame]):
    """Runs the real Phase 1 engine to get real ColumnProfile stats."""
    return DataProfiler().profile(tables)


def make_customers(n: int = 30) -> pd.DataFrame:
    return pd.DataFrame({"id": [f"C{i:03d}" for i in range(n)], "name": [f"Customer {i}" for i in range(n)]})


# ──────────────────────────────────────────────────────────────────────
# A. Positive relationship
# ──────────────────────────────────────────────────────────────────────


class TestPositiveRelationship:
    def test_orders_customer_id_references_customers_id(self):
        customers = make_customers(30)
        # Every order's customer_id is a real customer id -> perfect containment.
        orders = pd.DataFrame({
            "order_id": [f"O{i:03d}" for i in range(50)],
            "customer_id": [customers["id"][i % 30] for i in range(50)],
        })
        tables = {"customers": customers, "orders": orders}
        result = profile(tables)

        relationships = infer_relationships(tables, result.tables)

        matches = [r for r in relationships if r.child_table == "orders" and r.child_column == "customer_id"]
        assert len(matches) == 1
        rel = matches[0]
        assert rel.parent_table == "customers"
        assert rel.parent_column == "id"
        assert rel.value_overlap == 1.0
        assert rel.orphan_count == 0
        assert rel.confidence_band in {"high", "medium"}

    def test_evidence_explains_why_the_relationship_was_inferred(self):
        customers = make_customers(25)
        orders = pd.DataFrame({
            "order_id": [f"O{i:03d}" for i in range(40)],
            "customer_id": [customers["id"][i % 25] for i in range(40)],
        })
        tables = {"customers": customers, "orders": orders}
        result = profile(tables)
        [rel] = [r for r in infer_relationships(tables, result.tables) if r.child_column == "customer_id"]

        assert "score_terms" in rel.evidence
        assert "weights_used" in rel.evidence
        assert set(rel.evidence["score_terms"].keys()) >= {
            "containment", "name_similarity", "type_exactness", "null_rate_score",
        }
        assert rel.evidence["parent_distinct_count"] == 25


# ──────────────────────────────────────────────────────────────────────
# B. No relationship — unrelated columns must not produce one
# ──────────────────────────────────────────────────────────────────────


class TestNoRelationship:
    def test_unrelated_columns_with_no_value_overlap_produce_nothing(self):
        customers = make_customers(30)
        # products has no plausible FK into customers at all.
        products = pd.DataFrame({
            "sku": [f"SKU{i:04d}" for i in range(30)],
            "category": ["electronics", "home", "toys"] * 10,
        })
        tables = {"customers": customers, "products": products}
        result = profile(tables)

        relationships = infer_relationships(tables, result.tables)
        assert relationships == []

    def test_similar_column_names_alone_do_not_create_a_false_relationship(self):
        """The exact scenario requirement 5 warns about: two columns named
        alike but with genuinely unrelated values must not be linked."""
        customers = make_customers(30)
        # "customer_id" name, but values are from a totally different
        # domain (UUID-like strings), so containment will be ~0.
        unrelated = pd.DataFrame({
            "customer_id": [f"ZZZ-{i:05d}-UNRELATED" for i in range(30)],
            "notes": ["x"] * 30,
        })
        tables = {"customers": customers, "unrelated_table": unrelated}
        result = profile(tables)

        relationships = infer_relationships(tables, result.tables)
        matches = [r for r in relationships if r.child_table == "unrelated_table"]
        assert matches == [], (
            "name similarity alone must never be sufficient — containment was ~0 here"
        )

    def test_self_relationships_are_never_inferred(self):
        customers = make_customers(30)
        tables = {"customers": customers}
        result = profile(tables)
        assert infer_relationships(tables, result.tables) == []

    def test_low_containment_is_hard_gated_even_with_perfect_name_match(self):
        parent = pd.DataFrame({"id": [f"P{i:03d}" for i in range(25)]})
        # Only ~20% of child values exist in parent -> below MIN_CONTAINMENT.
        child_values = [f"P{i:03d}" for i in range(5)] + [f"X{i:03d}" for i in range(45)]
        child = pd.DataFrame({"id": child_values})
        tables = {"parent": parent, "child": child}
        result = profile(tables)

        relationships = infer_relationships(tables, result.tables)
        assert relationships == []


# ──────────────────────────────────────────────────────────────────────
# C. Orphan detection
# ──────────────────────────────────────────────────────────────────────


class TestOrphanDetection:
    def test_known_invalid_fk_values_are_detected_as_orphans(self):
        # A 100-customer parent, with only 40 of them actually referenced
        # by orders, leaves real headroom against the cardinality gate
        # (child distinct <= parent distinct * 1.05) once 10 distinct bad
        # ids are added — unlike referencing all 100, which would leave
        # almost no room for any orphan values at all.
        customers = make_customers(100)
        valid_pool = list(customers["id"])[:40]
        bad_ids = [f"BAD{i}" for i in range(10)]
        orders = pd.DataFrame({
            "order_id": [f"O{i:03d}" for i in range(50)],
            "customer_id": valid_pool + bad_ids,
        })
        tables = {"customers": customers, "orders": orders}
        result = profile(tables)

        [rel] = [r for r in infer_relationships(tables, result.tables) if r.child_column == "customer_id"]
        assert rel.orphan_count == 10
        assert rel.orphan_percentage == pytest.approx(20.0, abs=0.01)
        assert set(rel.orphan_examples).issubset(set(bad_ids))

    def test_orphan_examples_are_bounded_and_deterministic(self):
        # 100-customer parent; only 20 of them repeatedly referenced by
        # orders, leaving ample headroom for 8 distinct bad values without
        # tripping the cardinality gate (20 + 8 = 28 child-distinct, far
        # under 100 * 1.05 = 105).
        customers = make_customers(100)
        valid_pool = list(customers["id"])[:20]
        bad_ids = [f"BAD{i:03d}" for i in range(8)]  # more than MAX_ORPHAN_EXAMPLES (5)
        orders = pd.DataFrame({
            "order_id": [f"O{i:04d}" for i in range(188)],
            "customer_id": [valid_pool[i % 20] for i in range(180)] + bad_ids,
        })
        tables = {"customers": customers, "orders": orders}
        result = profile(tables)

        [rel] = [r for r in infer_relationships(tables, result.tables) if r.child_column == "customer_id"]
        assert rel.orphan_count == 8  # all 8 distinct bad values correctly counted...
        assert len(rel.orphan_examples) == MAX_ORPHAN_EXAMPLES  # ...but the examples list is capped
        assert rel.orphan_examples == sorted(rel.orphan_examples)  # deterministic ordering

    def test_no_complete_source_column_is_ever_stored_in_evidence_or_examples(self):
        customers = make_customers(50)
        orders = pd.DataFrame({
            "order_id": [f"O{i:03d}" for i in range(50)],
            "customer_id": list(customers["id"]),
        })
        tables = {"customers": customers, "orders": orders}
        result = profile(tables)
        [rel] = [r for r in infer_relationships(tables, result.tables) if r.child_column == "customer_id"]

        assert len(rel.orphan_examples) <= MAX_ORPHAN_EXAMPLES
        serialized_evidence_size = len(str(rel.evidence))
        assert serialized_evidence_size < 5000  # nowhere near large enough to hold a 50-row column


# ──────────────────────────────────────────────────────────────────────
# D. Confidence determinism
# ──────────────────────────────────────────────────────────────────────


class TestDeterminism:
    def test_same_input_produces_the_same_confidence_every_time(self):
        customers = make_customers(30)
        orders = pd.DataFrame({
            "order_id": [f"O{i:03d}" for i in range(45)],
            "customer_id": [customers["id"][i % 30] for i in range(45)],
        })
        tables = {"customers": customers, "orders": orders}

        results = []
        for _ in range(5):
            result = profile(tables)
            [rel] = [r for r in infer_relationships(tables, result.tables) if r.child_column == "customer_id"]
            results.append(rel.confidence)

        assert len(set(results)) == 1, f"confidence varied across runs: {results}"

    def test_output_ordering_is_deterministic_regardless_of_dict_construction_order(self):
        customers = make_customers(30)
        orders = pd.DataFrame({
            "order_id": [f"O{i:03d}" for i in range(40)],
            "customer_id": [customers["id"][i % 30] for i in range(40)],
        })

        tables_a = {"customers": customers, "orders": orders}
        tables_b = {"orders": orders, "customers": customers}  # reversed insertion order

        result_a = profile(tables_a)
        result_b = profile(tables_b)
        rels_a = infer_relationships(tables_a, result_a.tables)
        rels_b = infer_relationships(tables_b, result_b.tables)

        assert [(r.parent_table, r.parent_column, r.child_table, r.child_column) for r in rels_a] == [
            (r.parent_table, r.parent_column, r.child_table, r.child_column) for r in rels_b
        ]


# ──────────────────────────────────────────────────────────────────────
# Confidence weights / bands — explicit, testable design constants
# ──────────────────────────────────────────────────────────────────────


class TestConfidenceWeightsAndBands:
    def test_weights_sum_to_exactly_one(self):
        total = (
            CONFIDENCE_WEIGHT_CONTAINMENT
            + CONFIDENCE_WEIGHT_NAME_SIMILARITY
            + CONFIDENCE_WEIGHT_TYPE_EXACTNESS
            + CONFIDENCE_WEIGHT_NULL_RATE
        )
        assert total == pytest.approx(1.0)

    def test_confidence_formula_matches_the_documented_weighted_sum(self):
        containment, name_sim, type_score, null_rate = 0.9, 0.8, 1.0, 0.95
        expected = round(
            CONFIDENCE_WEIGHT_CONTAINMENT * containment
            + CONFIDENCE_WEIGHT_NAME_SIMILARITY * name_sim
            + CONFIDENCE_WEIGHT_TYPE_EXACTNESS * type_score
            + CONFIDENCE_WEIGHT_NULL_RATE * null_rate,
            6,
        )
        assert expected == pytest.approx(0.55 * 0.9 + 0.20 * 0.8 + 0.15 * 1.0 + 0.10 * 0.95)

    @pytest.mark.parametrize(
        "confidence,expected_band",
        [
            (0.95, "high"),
            (CONFIDENCE_BAND_HIGH_MIN, "high"),
            (0.84999, "medium"),
            (CONFIDENCE_BAND_MEDIUM_MIN, "medium"),
            (0.5, "low"),
            (0.64999, "low"),
        ],
    )
    def test_confidence_band_boundaries(self, confidence, expected_band):
        from app.relationships.inference import _confidence_band

        assert _confidence_band(confidence) == expected_band

    def test_min_confidence_to_report_matches_min_containment_by_documented_coincidence(self):
        # Both happen to be 0.50 but gate different quantities (raw
        # containment vs final weighted confidence) — this test exists so
        # a future edit to one doesn't silently drift without notice.
        assert MIN_CONFIDENCE_TO_REPORT == 0.50
        assert MIN_CONTAINMENT == 0.50


# ──────────────────────────────────────────────────────────────────────
# Pure helper functions
# ──────────────────────────────────────────────────────────────────────


class TestNameSimilarity:
    def test_exact_normalized_match_scores_1(self):
        assert name_similarity("customers", "customer_id", "orders", "customer_id") == 1.0

    def test_completely_different_names_score_low(self):
        score = name_similarity("customers", "id", "orders", "shipping_zone")
        assert score < 0.5

    def test_is_pure_and_deterministic(self):
        a = name_similarity("customers", "id", "orders", "customer_id")
        b = name_similarity("customers", "id", "orders", "customer_id")
        assert a == b


class TestTypeExactness:
    def test_exact_match_is_1(self):
        assert type_exactness("integer", "integer") == 1.0

    def test_int_string_mismatch_is_0_6(self):
        assert type_exactness("integer", "string") == 0.6
        assert type_exactness("string", "integer") == 0.6

    def test_incompatible_types_score_0(self):
        assert type_exactness("date", "boolean") == 0.0


class TestNormalizeToken:
    def test_strips_id_suffix(self):
        assert _normalize_token("customer_id") == "customer"

    def test_never_returns_empty_string(self):
        assert _normalize_token("id") != ""


class TestErrorHandling:
    """Requirement 10: never crash on one bad candidate pair."""

    def test_empty_table_does_not_crash_inference(self):
        customers = make_customers(30)
        empty = pd.DataFrame({"a": []})
        tables = {"customers": customers, "empty_table": empty}
        result = profile(tables)
        # Should not raise.
        relationships = infer_relationships(tables, result.tables)
        assert isinstance(relationships, list)

    def test_all_missing_column_is_not_treated_as_a_parent_candidate(self):
        customers = pd.DataFrame({"id": ["NULL"] * 30, "name": [f"n{i}" for i in range(30)]})
        orders = pd.DataFrame({"customer_id": ["NULL"] * 30})
        tables = {"customers": customers, "orders": orders}
        result = profile(tables)
        assert infer_relationships(tables, result.tables) == []


class TestIsParentCandidate:
    def test_accepts_a_genuine_unique_id_column(self):
        customers = make_customers(30)
        result = profile({"customers": customers})
        id_profile = next(c for c in result.tables[0].columns if c.name == "id")
        assert _is_parent_candidate(id_profile) is True

    def test_rejects_a_low_cardinality_column(self):
        df = pd.DataFrame({"status": ["active", "inactive"] * 15})
        result = profile({"t": df})
        status_profile = next(c for c in result.tables[0].columns if c.name == "status")
        assert _is_parent_candidate(status_profile) is False


class TestComputeContainment:
    def test_perfect_overlap_is_containment_1(self):
        parent = pd.Series(["a", "b", "c"])
        child = pd.Series(["a", "b", "a", "c"])
        result = _compute_containment(parent, child)
        assert result.containment == 1.0
        assert result.orphan_count == 0

    def test_empty_child_after_filtering_missing_values_is_handled_safely(self):
        parent = pd.Series(["a", "b"])
        child = pd.Series(["NULL", "", "na"])
        result = _compute_containment(parent, child)
        assert result.containment == 0.0
        assert result.child_checked_count == 0
        assert result.orphan_count == 0  # not an orphan — there's nothing to check
