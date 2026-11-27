import pytest

from evaluation.detector_contract import Finding, ContractViolation, validate_finding


def make_valid_dict(**overrides) -> dict:
    base = dict(
        issue_type="missing_value",
        dimension="completeness",
        table="customers",
        row_uid="abc-123",
        column="email",
        severity="low",
    )
    base.update(overrides)
    return base


def test_accepts_a_well_formed_dict():
    finding = validate_finding(make_valid_dict())
    assert isinstance(finding, Finding)
    assert finding.row_uid == "abc-123"


def test_accepts_a_finding_instance_directly():
    finding = Finding(
        issue_type="missing_value",
        dimension="completeness",
        table="customers",
        row_uid="abc-123",
        column="email",
        severity="low",
    )
    assert validate_finding(finding) is finding


def test_column_may_be_none_for_row_level_defects():
    finding = validate_finding(make_valid_dict(column=None, issue_type="duplicate_row"))
    assert finding.column is None


@pytest.mark.parametrize("missing_field", ["issue_type", "dimension", "table", "row_uid", "column", "severity"])
def test_rejects_missing_required_field(missing_field):
    data = make_valid_dict()
    del data[missing_field]
    with pytest.raises(ContractViolation):
        validate_finding(data)


def test_rejects_empty_row_uid():
    with pytest.raises(ContractViolation, match="row_uid"):
        validate_finding(make_valid_dict(row_uid=""))


def test_rejects_invalid_severity():
    with pytest.raises(ContractViolation, match="severity"):
        validate_finding(make_valid_dict(severity="catastrophic"))


def test_rejects_invalid_dimension():
    with pytest.raises(ContractViolation, match="dimension"):
        validate_finding(make_valid_dict(dimension="vibes"))


def test_rejects_non_dict_non_finding():
    with pytest.raises(ContractViolation):
        validate_finding("not a finding")


def test_rejects_non_string_column():
    with pytest.raises(ContractViolation, match="column"):
        validate_finding(make_valid_dict(column=123))
