# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Joeybuilt LLC

"""
Phase F unit tests for schema_registry (ADR 0029).

Coverage:
- Registry loads all 4 shipped schemas (plexo/levio/frame-forge/helm).
- validate() permissive default (STRICT_SCHEMA unset): unknown app/label/
  required-missing/extra-prop all return None (no exception, just a log).
- validate(strict=True): same conditions raise ValidationError.
- validate_edge() endpoint mismatches behave per strict flag.
- graph_name() honors graph_template + back-compat fallback.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Sidecar root on sys.path so `import schema_registry` resolves.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import schema_registry  # noqa: E402


def test_loads_all_four_apps():
    apps = set(schema_registry.registered_apps())
    assert {"plexo", "levio", "frame-forge", "helm"}.issubset(apps)


def test_plexo_labels_present():
    labels = set(schema_registry.registered_labels("plexo"))
    # Per schemas/plexo.yaml — must include Episodic + Entity + the per-fact
    # subtype labels the existing /v1/triplets endpoint already emits.
    assert {"Episodic", "Entity", "IdentityFact", "PreferenceFact", "SkillFact"}.issubset(labels)


def test_validate_permissive_unknown_app_no_raise():
    # No exception even though "no-such-app" is unregistered.
    schema_registry.validate("no-such-app", "Whatever", {"k": "v"})


def test_validate_strict_unknown_app_raises():
    with pytest.raises(schema_registry.ValidationError, match="no registered schema"):
        schema_registry.validate("no-such-app", "Entity", {"name": "x"}, strict=True)


def test_validate_strict_unknown_label_raises():
    with pytest.raises(schema_registry.ValidationError, match="no registered label"):
        schema_registry.validate("plexo", "BogusLabel", {}, strict=True)


def test_validate_strict_missing_required_raises():
    # Episodic requires content + source_description.
    with pytest.raises(schema_registry.ValidationError, match="missing required"):
        schema_registry.validate(
            "plexo", "Episodic", {"content": "hi"}, strict=True
        )


def test_validate_strict_unknown_property_raises():
    with pytest.raises(schema_registry.ValidationError, match="unregistered props"):
        schema_registry.validate(
            "plexo", "Entity", {"name": "x", "wat": "no"}, strict=True
        )


def test_validate_strict_happy_path():
    schema_registry.validate(
        "plexo",
        "Entity",
        {"name": "operator", "summary": "operator"},
        strict=True,
    )
    schema_registry.validate(
        "levio",
        "Email",
        {"body": "hi", "sent_at": "2026-01-01T00:00:00Z"},
        strict=True,
    )


def test_validate_edge_strict_unknown_type_raises():
    with pytest.raises(schema_registry.ValidationError, match="no registered edge type"):
        schema_registry.validate_edge("plexo", "BOGUS_EDGE", strict=True)


def test_validate_edge_strict_endpoint_mismatch_raises():
    # plexo RELATES_TO expects from=Entity to=Entity.
    with pytest.raises(schema_registry.ValidationError, match="expects from=Entity"):
        schema_registry.validate_edge(
            "plexo",
            "RELATES_TO",
            from_label="Episodic",
            to_label="Entity",
            strict=True,
        )


def test_validate_edge_strict_unknown_prop_raises():
    with pytest.raises(schema_registry.ValidationError, match="unregistered props"):
        schema_registry.validate_edge(
            "plexo",
            "RELATES_TO",
            properties={"bogus_key": "x"},
            strict=True,
        )


def test_validate_edge_strict_happy_path():
    schema_registry.validate_edge(
        "plexo",
        "RELATES_TO",
        from_label="Entity",
        to_label="Entity",
        properties={"fact": "x", "plexo_memory_id": "id", "plexo_memory_type": "session"},
        strict=True,
    )


def test_graph_name_template_substitution():
    assert schema_registry.graph_name("plexo", "ws-1") == "plexo:ws-1"
    assert schema_registry.graph_name("levio", "ws-2") == "levio:ws-2"
    assert schema_registry.graph_name("frame-forge", "ws-3") == "frame-forge:ws-3"


def test_graph_name_unknown_app_back_compat():
    # Unknown app → bare workspace_id (legacy plexo sidecar convention).
    assert schema_registry.graph_name("ghost", "ws-7") == "ws-7"
