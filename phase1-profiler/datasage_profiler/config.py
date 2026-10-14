"""Configuration for the Phase 1 detectors.

The defaults intentionally favor precision over recall.  A later integration
layer can provide stricter settings for a known domain without changing the
detectors themselves.
"""

from dataclasses import dataclass
from typing import FrozenSet, Tuple


@dataclass(frozen=True)
class ProfilerConfig:
    """Tunable detector behavior.

    Required fields are inferred only from explicit names/patterns or a
    configured list.  Outliers use Tukey's IQR rule by default and are not
    reported for tiny samples.
    """

    required_columns: Tuple[str, ...] = ()
    required_name_patterns: Tuple[str, ...] = (
        "id",
        "key",
        "email",
        "name",
        "status",
        "date",
        "amount",
        "total",
    )
    candidate_key_patterns: Tuple[str, ...] = (
        "id",
        "key",
        "uuid",
        "email",
        "code",
    )
    numeric_name_patterns: Tuple[str, ...] = (
        "amount",
        "count",
        "number",
        "price",
        "quantity",
        "score",
        "total",
        "year",
    )
    date_name_patterns: Tuple[str, ...] = (
        "date",
        "time",
        "timestamp",
        "created",
        "updated",
        "dob",
        "birth",
    )
    missing_tokens: FrozenSet[str] = frozenset({"", "na", "n/a", "null", "none", "nan"})
    outlier_method: str = "iqr"
    outlier_iqr_multiplier: float = 1.5
    outlier_min_non_null: int = 8
    value_consistency_min_dominant_count: int = 3
    value_consistency_max_cardinality_ratio: float = 0.5
    value_consistency_max_edit_distance: int = 1
    value_consistency_min_similarity: float = 0.88

    def __post_init__(self) -> None:
        if self.outlier_method not in {"iqr"}:
            raise ValueError("outlier_method must be 'iqr'")
        if self.outlier_iqr_multiplier <= 0:
            raise ValueError("outlier_iqr_multiplier must be positive")
        if self.outlier_min_non_null < 4:
            raise ValueError("outlier_min_non_null must be at least 4")