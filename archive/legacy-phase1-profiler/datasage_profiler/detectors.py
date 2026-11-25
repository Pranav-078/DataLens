"""Phase 1 quality detectors.

The detectors intentionally report findings, not a quality score.  Scoring
and relationship analysis are explicitly outside Phase 1.
"""

from __future__ import annotations

import difflib
from collections import Counter, defaultdict
from typing import Any, Dict, Iterable, List, Optional, Sequence

import pandas as pd

from .config import ProfilerConfig
from .contracts import Detector, DetectorContext
from .models import ColumnProfile, Issue
from .utils import (
    compact_key,
    date_format,
    infer_type,
    is_missing,
    levenshtein_distance,
    name_matches,
    normalized_key,
    parse_date,
    parse_number,
    stable_issue_id,
)


def _safe_value(value: Any) -> Any:
    if value is None:
        return None
    text = str(value)
    return text if len(text) <= 200 else text[:197] + "..."


def _issue(
    *,
    issue_type: str,
    severity: str,
    table: str,
    column: Optional[str],
    description: str,
    detector: str,
    row_reference: Optional[Dict[str, Any]] = None,
    observed_value: Any = None,
    confidence: Optional[float] = None,
    details: Optional[Dict[str, Any]] = None,
) -> Issue:
    payload = {
        "issue_type": issue_type,
        "severity": severity,
        "table": table,
        "column": column,
        "row_reference": row_reference,
        "observed_value": _safe_value(observed_value),
        "description": description,
        "detector": detector,
        "confidence": confidence,
        "details": details or {},
    }
    return Issue(issue_id=stable_issue_id(payload), **payload)


def _profile_for(context: DetectorContext, name: str) -> ColumnProfile:
    return next(column for column in context.columns if column.name == name)


def _values_with_rows(series: pd.Series, config: ProfilerConfig) -> Iterable[tuple[int, Any]]:
    for row_index, value in series.items():
        if not is_missing(value, config.missing_tokens):
            yield int(row_index), value


class DuplicateDetector:
    name = "duplicate_detector"

    def detect(self, context: DetectorContext) -> List[Issue]:
        frame = context.frame
        config = context.config
        findings: List[Issue] = []
        if len(frame.columns):
            duplicate_mask = frame.duplicated(keep=False)
            groups: Dict[tuple, List[int]] = defaultdict(list)
            for row_index in frame.index[duplicate_mask]:
                row = frame.loc[row_index]
                key = tuple(str(value) for value in row.tolist())
                groups[key].append(int(row_index))
            for row_indices in sorted(groups.values(), key=lambda rows: rows[0]):
                if len(row_indices) < 2:
                    continue
                findings.append(
                    _issue(
                        issue_type="duplicate_full_record",
                        severity="warning",
                        table=context.table,
                        column=None,
                        row_reference={"row_indices": row_indices},
                        observed_value="identical full records",
                        description=f"{len(row_indices)} identical full records were found.",
                        detector=self.name,
                        confidence=1.0,
                        details={"duplicate_count": len(row_indices)},
                    )
                )

        for column in frame.columns:
            column_name = str(column)
            if not name_matches(column_name, config.candidate_key_patterns):
                continue
            groups = defaultdict(list)
            for row_index, value in _values_with_rows(frame[column], config):
                groups[normalized_key(value)].append(int(row_index))
            for key, row_indices in sorted(groups.items()):
                if not key or len(row_indices) < 2:
                    continue
                observed = frame.loc[row_indices[0], column]
                findings.append(
                    _issue(
                        issue_type="duplicate_candidate_key",
                        severity="warning",
                        table=context.table,
                        column=column_name,
                        row_reference={"row_indices": row_indices},
                        observed_value=observed,
                        description=(
                            f"Candidate-key column '{column_name}' repeats the value "
                            f"{len(row_indices)} times."
                        ),
                        detector=self.name,
                        confidence=0.9,
                        details={"duplicate_count": len(row_indices)},
                    )
                )
        return findings


class TypeQualityDetector:
    name = "type_quality_detector"

    def detect(self, context: DetectorContext) -> List[Issue]:
        findings: List[Issue] = []
        config = context.config
        for column in context.frame.columns:
            name = str(column)
            series = context.frame[column]
            values = list(_values_with_rows(series, config))
            if not values:
                continue
            numeric_values = [(row, value) for row, value in values if parse_number(value) is not None]
            date_values = [(row, value) for row, value in values if parse_date(value) is not None]
            numeric_hint = name_matches(name, config.numeric_name_patterns)
            date_hint = name_matches(name, config.date_name_patterns)
            inferred = infer_type(
                series,
                config.missing_tokens,
                numeric_name_hint=numeric_hint,
                date_name_hint=date_hint,
            )
            if (numeric_hint or inferred in {"integer", "float"}) and len(numeric_values) >= 3:
                invalid = [(row, value) for row, value in values if parse_number(value) is None]
                for row, value in invalid:
                    findings.append(
                        _issue(
                            issue_type="invalid_numeric",
                            severity="error",
                            table=context.table,
                            column=name,
                            row_reference={"row_index": row},
                            observed_value=value,
                            description=f"Value in numeric-like column '{name}' is not numeric.",
                            detector=self.name,
                            confidence=0.95 if numeric_hint else 0.85,
                        )
                    )
            if numeric_values and len(numeric_values) < len(values) and not numeric_hint:
                findings.append(
                    _issue(
                        issue_type="mixed_type",
                        severity="warning",
                        table=context.table,
                        column=name,
                        row_reference=None,
                        observed_value={"numeric_values": len(numeric_values), "total_values": len(values)},
                        description=f"Column '{name}' contains numeric and non-numeric value forms.",
                        detector=self.name,
                        confidence=0.75,
                    )
                )
            if date_hint or inferred == "date":
                invalid_dates = [(row, value) for row, value in values if parse_date(value) is None]
                for row, value in invalid_dates:
                    findings.append(
                        _issue(
                            issue_type="invalid_date",
                            severity="error",
                            table=context.table,
                            column=name,
                            row_reference={"row_index": row},
                            observed_value=value,
                            description=f"Value in date-like column '{name}' is not a valid date.",
                            detector=self.name,
                            confidence=0.95 if date_hint else 0.85,
                        )
                    )
                formats = Counter(date_format(value) for _, value in date_values if date_format(value))
                if len(formats) > 1:
                    findings.append(
                        _issue(
                            issue_type="inconsistent_date_format",
                            severity="warning",
                            table=context.table,
                            column=name,
                            row_reference=None,
                            observed_value=dict(sorted(formats.items())),
                            description=f"Date-like column '{name}' uses more than one date format.",
                            detector=self.name,
                            confidence=0.9,
                            details={"formats": dict(sorted(formats.items()))},
                        )
                    )
        return findings


class StringQualityDetector:
    name = "string_quality_detector"

    def detect(self, context: DetectorContext) -> List[Issue]:
        findings: List[Issue] = []
        config = context.config
        for column in context.frame.columns:
            name = str(column)
            series = context.frame[column]
            empty_rows = [
                int(row) for row, value in series.items()
                if isinstance(value, str) and value.strip() == ""
            ]
            if empty_rows:
                findings.append(
                    _issue(
                        issue_type="empty_string",
                        severity="warning",
                        table=context.table,
                        column=name,
                        row_reference={"row_indices": empty_rows},
                        observed_value="",
                        description=f"Column '{name}' contains {len(empty_rows)} empty strings.",
                        detector=self.name,
                        confidence=1.0,
                        details={"count": len(empty_rows)},
                    )
                )
            for row, value in _values_with_rows(series, config):
                if isinstance(value, str) and value != value.strip():
                    findings.append(
                        _issue(
                            issue_type="leading_trailing_whitespace",
                            severity="warning",
                            table=context.table,
                            column=name,
                            row_reference={"row_index": row},
                            observed_value=value,
                            description=f"Value in '{name}' has leading or trailing whitespace.",
                            detector=self.name,
                            confidence=1.0,
                        )
                    )
                if isinstance(value, str) and ("\ufffd" in value or any(ord(char) < 32 and char not in "\t\n\r" for char in value)):
                    findings.append(
                        _issue(
                            issue_type="encoding_edge_case",
                            severity="warning",
                            table=context.table,
                            column=name,
                            row_reference={"row_index": row},
                            observed_value=value,
                            description=f"Value in '{name}' contains a replacement or control character.",
                            detector=self.name,
                            confidence=0.95,
                        )
                    )
            casing_groups: Dict[str, List[tuple[int, Any]]] = defaultdict(list)
            for row, value in _values_with_rows(series, config):
                if isinstance(value, str):
                    casing_groups[normalized_key(value)].append((row, value))
            for normalized, entries in sorted(casing_groups.items()):
                variants = {str(value) for _, value in entries}
                if normalized and len(variants) > 1:
                    findings.append(
                        _issue(
                            issue_type="casing_inconsistency",
                            severity="warning",
                            table=context.table,
                            column=name,
                            row_reference={"row_indices": sorted(row for row, _ in entries)},
                            observed_value=sorted(variants),
                            description=f"Equivalent values in '{name}' use inconsistent casing or spacing.",
                            detector=self.name,
                            confidence=0.9,
                            details={"normalized_value": normalized, "variants": sorted(variants)},
                        )
                    )
        return findings


class RequiredFieldDetector:
    name = "required_field_detector"

    def detect(self, context: DetectorContext) -> List[Issue]:
        findings: List[Issue] = []
        config = context.config
        explicit = {name.casefold() for name in config.required_columns}
        for column in context.frame.columns:
            name = str(column)
            if name.casefold() not in explicit and not name_matches(name, config.required_name_patterns):
                continue
            missing_rows = [
                int(row) for row, value in context.frame[name].items()
                if is_missing(value, config.missing_tokens)
            ]
            if not missing_rows:
                continue
            source = "explicit configuration" if name.casefold() in explicit else "required-name heuristic"
            findings.append(
                _issue(
                    issue_type="required_field_missing",
                    severity="error",
                    table=context.table,
                    column=name,
                    row_reference={"row_indices": missing_rows},
                    observed_value=None,
                    description=(
                        f"Required-like column '{name}' has {len(missing_rows)} missing values; "
                        f"classified using {source}."
                    ),
                    detector=self.name,
                    confidence=1.0 if name.casefold() in explicit else 0.7,
                    details={
                        "heuristic": (
                            "Configured required_columns are always required; otherwise "
                            "column names matching common identifier/business-field patterns "
                            "are treated as required-like."
                        ),
                        "classification_source": source,
                    },
                )
            )
        return findings


class NumericOutlierDetector:
    name = "numeric_outlier_detector"

    def detect(self, context: DetectorContext) -> List[Issue]:
        findings: List[Issue] = []
        config = context.config
        for column in context.frame.columns:
            name = str(column)
            profile = _profile_for(context, name)
            if profile.inferred_type not in {"integer", "float"}:
                continue
            values = [(row, parse_number(value)) for row, value in context.frame[name].items()]
            numeric = [(row, value) for row, value in values if value is not None]
            if len(numeric) < config.outlier_min_non_null:
                continue
            numeric_series = pd.Series([value for _, value in numeric], dtype="float64")
            q1 = float(numeric_series.quantile(0.25))
            q3 = float(numeric_series.quantile(0.75))
            iqr = q3 - q1
            if iqr == 0:
                continue
            lower = q1 - config.outlier_iqr_multiplier * iqr
            upper = q3 + config.outlier_iqr_multiplier * iqr
            for row, value in numeric:
                if value < lower or value > upper:
                    findings.append(
                        _issue(
                            issue_type="numeric_outlier",
                            severity="warning",
                            table=context.table,
                            column=name,
                            row_reference={"row_index": row},
                            observed_value=value,
                            description=(
                                f"Numeric value {value:g} in '{name}' is outside the "
                                f"Tukey IQR bounds [{lower:g}, {upper:g}]."
                            ),
                            detector=self.name,
                            confidence=0.85,
                            details={
                                "algorithm": "Tukey IQR",
                                "iqr_multiplier": config.outlier_iqr_multiplier,
                                "q1": q1,
                                "q3": q3,
                                "lower_bound": lower,
                                "upper_bound": upper,
                            },
                        )
                    )
        return findings


class ValueConsistencyDetector:
    name = "value_consistency_detector"

    def detect(self, context: DetectorContext) -> List[Issue]:
        findings: List[Issue] = []
        config = context.config
        for column in context.frame.columns:
            name = str(column)
            profile = _profile_for(context, name)
            if profile.inferred_type not in {"string", "boolean"}:
                continue
            values = [(row, str(value)) for row, value in _values_with_rows(context.frame[name], config)]
            if not values or profile.unique_count / max(profile.non_null_count, 1) > config.value_consistency_max_cardinality_ratio:
                continue
            counts = Counter(value for _, value in values)
            dominant = [
                value for value, count in counts.items()
                if count >= config.value_consistency_min_dominant_count
            ]
            variants = [value for value, count in counts.items() if count < config.value_consistency_min_dominant_count]
            for variant in sorted(variants):
                best: Optional[str] = None
                best_score = 0.0
                for candidate in dominant:
                    if normalized_key(candidate) == normalized_key(variant):
                        continue
                    left, right = compact_key(candidate), compact_key(variant)
                    if not left or not right:
                        continue
                    distance = levenshtein_distance(left, right)
                    score = difflib.SequenceMatcher(None, left, right).ratio()
                    if distance <= config.value_consistency_max_edit_distance or score >= config.value_consistency_min_similarity:
                        if score > best_score:
                            best, best_score = candidate, score
                if best is None:
                    continue
                rows = [row for row, value in values if value == variant]
                findings.append(
                    _issue(
                        issue_type="inconsistent_categorical_value",
                        severity="warning",
                        table=context.table,
                        column=name,
                        row_reference={"row_indices": rows},
                        observed_value=variant,
                        description=(
                            f"Categorical value '{variant}' in '{name}' is a likely variant "
                            f"of common value '{best}'."
                        ),
                        detector=self.name,
                        confidence=round(min(0.99, 0.7 + best_score * 0.29), 6),
                        details={
                            "dominant_value": best,
                            "dominant_count": counts[best],
                            "variant_count": counts[variant],
                            "similarity": round(best_score, 6),
                            "heuristic": (
                                "Only low-cardinality columns are checked; a rare value must "
                                "be very close to a repeated value."
                            ),
                        },
                    )
                )
        return findings


DEFAULT_DETECTORS: Sequence[Detector] = (
    DuplicateDetector(),
    TypeQualityDetector(),
    StringQualityDetector(),
    RequiredFieldDetector(),
    NumericOutlierDetector(),
    ValueConsistencyDetector(),
)