"""Shared normalization, inference, and deterministic serialization helpers."""

from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime
from functools import lru_cache
from typing import Any, Iterable, List, Optional, Sequence, Tuple

import pandas as pd


_DATE_FORMATS: Tuple[str, ...] = (
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%d/%m/%Y",
    "%m/%d/%Y",
    "%Y-%m-%d %H:%M:%S",
    "%Y/%m/%d %H:%M:%S",
    "%d/%m/%Y %H:%M:%S",
    "%m/%d/%Y %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M:%SZ",
)

# Fast lexical gate: the general pandas/dateutil parser is useful for flexible
# human-entered dates, but calling it for every arbitrary cell (UUIDs, names,
# descriptions, etc.) is disproportionately expensive on large CSV batches.
# Only date-shaped values are allowed through to the full parser.
_DATE_WORDS = frozenset({
    "jan", "january", "feb", "february", "mar", "march", "apr", "april",
    "may", "jun", "june", "jul", "july", "aug", "august", "sep", "sept",
    "september", "oct", "october", "nov", "november", "dec", "december",
    "mon", "monday", "tue", "tues", "tuesday", "wed", "wednesday",
    "thu", "thur", "thurs", "thursday", "fri", "friday", "sat", "saturday",
    "sun", "sunday", "am", "pm", "utc", "gmt", "t", "z", "st", "nd", "rd", "th",
})
_DATE_WORD_PATTERN = re.compile(r"[A-Za-z]+")
_NUMERIC_DATE_SHAPE = re.compile(r"^[0-9][0-9:/ .+TtZz-]*$")
_MONTH_DATE_SHAPE = re.compile(r"^[A-Za-z0-9 ,./:+-]+$")


def _looks_like_date_text(text: str) -> bool:
    if not text or not any(char.isdigit() for char in text):
        return False

    words = {word.casefold() for word in _DATE_WORD_PATTERN.findall(text)}
    if any(word not in _DATE_WORDS for word in words):
        return False

    if _NUMERIC_DATE_SHAPE.fullmatch(text):
        # Separators are a stronger signal than a decimal point. Keep compact
        # YYYY and YYYYMMDD forms supported by pandas' flexible parser.
        return any(separator in text for separator in "-/:") or (text.isdigit() and len(text) in {4, 8})

    return bool(words.intersection(_DATE_WORDS)) and bool(_MONTH_DATE_SHAPE.fullmatch(text))


@lru_cache(maxsize=32)
def _casefold_tokens(tokens: frozenset[str]) -> frozenset[str]:
    return frozenset(token.casefold() for token in tokens)


def is_missing(value: Any, missing_tokens: Iterable[str]) -> bool:
    if value is None:
        return True
    if isinstance(value, float) and math.isnan(value):
        return True
    return str(value).strip().casefold() in _casefold_tokens(frozenset(missing_tokens))


def is_null_value(value: Any, missing_tokens: Iterable[str]) -> bool:
    """Return true for null-like values, excluding the empty-string bucket."""
    if value is None:
        return True
    if isinstance(value, float) and math.isnan(value):
        return True
    tokens = _casefold_tokens(frozenset(token for token in missing_tokens if token != ""))
    return str(value).strip().casefold() in tokens


def clean_text(value: Any) -> str:
    return str(value) if value is not None else ""


def non_missing_values(series: pd.Series, missing_tokens: Iterable[str]) -> List[str]:
    return [clean_text(value) for value in series.tolist() if not is_missing(value, missing_tokens)]


def normalized_key(value: Any) -> str:
    return re.sub(r"\s+", " ", clean_text(value).strip()).casefold()


def compact_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", normalized_key(value))


def name_matches(name: str, patterns: Sequence[str]) -> bool:
    lowered = name.casefold()
    tokens = set(re.findall(r"[a-z0-9]+", lowered))
    return any(
        pattern.casefold() in tokens
        or (len(pattern) > 2 and pattern.casefold() in lowered)
        for pattern in patterns
    )


_NUMERIC_TEXT_SHAPE = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$")


def parse_number(value: Any) -> Optional[float]:
    text = clean_text(value).strip()
    if not text:
        return None
    text = text.replace(",", "")
    if not _NUMERIC_TEXT_SHAPE.fullmatch(text):
        return None
    try:
        number = float(text)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


@lru_cache(maxsize=131072)
def _parse_date_text(text: str) -> Optional[datetime]:
    """Parse a date string once and reuse the result across profiler stages.

    ISO date/timestamp strings are common in CSV exports. fromisoformat is
    substantially cheaper than trying every strptime format. A trailing Z
    is deliberately left to the existing format loop to preserve its
    existing naive-datetime behavior.
    """
    if not text.endswith("Z"):
        try:
            return datetime.fromisoformat(text)
        except ValueError:
            pass
    for date_format in _DATE_FORMATS:
        try:
            return datetime.strptime(text, date_format)
        except ValueError:
            continue
    parsed = pd.to_datetime(text, errors="coerce", utc=False)
    if pd.isna(parsed):
        return None
    return parsed.to_pydatetime() if hasattr(parsed, "to_pydatetime") else parsed


def parse_date(value: Any) -> Optional[datetime]:
    text = clean_text(value).strip()
    if not _looks_like_date_text(text):
        return None
    return _parse_date_text(text)


def date_format(value: Any) -> Optional[str]:
    text = clean_text(value).strip()
    for candidate in _DATE_FORMATS:
        try:
            datetime.strptime(text, candidate)
            return candidate
        except ValueError:
            continue
    return "iso-or-library-parsed" if parse_date(text) is not None else None


def infer_type(
    series: pd.Series,
    missing_tokens: Iterable[str],
    numeric_name_hint: bool = False,
    date_name_hint: bool = False,
) -> str:
    values = non_missing_values(series, missing_tokens)
    if not values:
        return "unknown"
    parsed_numbers = [parse_number(value) for value in values]
    numeric_values = [number for number in parsed_numbers if number is not None]
    numeric_count = len(numeric_values)
    date_count = sum(parse_date(value) is not None for value in values)
    boolean_count = sum(value.casefold() in {"true", "false", "yes", "no", "0", "1"} for value in values)
    total = len(values)
    is_integer = all(number.is_integer() for number in numeric_values)
    if date_name_hint and date_count / total >= 0.5:
        return "date"
    if numeric_name_hint and numeric_count / total >= 0.5:
        return "integer" if is_integer else "float"
    if date_count == total and total >= 2:
        return "date"
    if numeric_count == total:
        return "integer" if is_integer else "float"
    if numeric_count / total >= 0.8 and numeric_count >= 3:
        return "integer" if is_integer else "float"
    if boolean_count == total:
        return "boolean"
    return "string"


def stable_issue_id(payload: dict) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return "ds1_" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:16]


def deterministic_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, default=str) + "\n"


def levenshtein_distance(left: str, right: str) -> int:
    if left == right:
        return 0
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for i, left_char in enumerate(left, start=1):
        current = [i]
        for j, right_char in enumerate(right, start=1):
            current.append(min(
                current[-1] + 1,
                previous[j] + 1,
                previous[j - 1] + (left_char != right_char),
            ))
        previous = current
    return previous[-1]