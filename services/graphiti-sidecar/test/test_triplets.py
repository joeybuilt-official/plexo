# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Joeybuilt LLC

"""
Phase A unit tests for POST /v1/triplets (ADR 0013 Route A bypass).

Coverage:
- Single triplet write returns expected response shape (triplet_id + both
  latencies as non-negative ints).
- Dedup: writing the same triplet twice both return 200 (graphiti dedups
  internally; the endpoint is idempotent at the response shape level).
- Invalid workspace_id returns 422.
- Missing / malformed source_metadata returns 422.

A live graphiti-core instance is not in the unit-test budget, so
graphiti.add_triplet is mocked. The mock asserts that the EntityNode +
EntityEdge construction matches the schema-mapping.md §3 contract
(labels carry entity type, attributes carry plexo_memory_type, edge name
== predicate, group_id == workspace_id).
"""

from __future__ import annotations

import hashlib
import hmac
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

# Tests live in services/graphiti-sidecar/test/; main.py lives one level up.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Set service key before importing main so module-level SERVICE_KEY captures it.
os.environ["PLEXO_SERVICE_KEY"] = "test-service-key"

import main  # noqa: E402


WORKSPACE_ID = "11111111-2222-3333-4444-555555555555"
MEMORY_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa"


def _sign(body: bytes) -> dict[str, str]:
    ts = datetime.now(timezone.utc).isoformat()
    sig = "sha256=" + hmac.new(
        main.SERVICE_KEY.encode("utf-8"), body, hashlib.sha256
    ).hexdigest()
    return {"X-Plexo-Signature": sig, "X-Plexo-Timestamp": ts, "Content-Type": "application/json"}


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture
def fake_graphiti():
    """Mock Graphiti so the route never touches Kuzu / LLMs.

    add_triplet returns an AddTripletResults-shaped object whose edges[0].uuid
    is captured from the EntityEdge the route constructed — letting the test
    inspect what the route built without depending on graphiti-core's dedup
    behavior.
    """
    captured: dict = {}

    async def fake_add_triplet(source_node, edge, target_node):
        captured["source_node"] = source_node
        captured["edge"] = edge
        captured["target_node"] = target_node
        return SimpleNamespace(nodes=[source_node, target_node], edges=[edge])

    inst = SimpleNamespace(add_triplet=fake_add_triplet)

    async def fake_get_graphiti(workspace_id: str):
        return inst

    with patch.object(main, "_get_graphiti", AsyncMock(side_effect=fake_get_graphiti)):
        yield captured


def _valid_body() -> dict:
    return {
        "workspace_id": WORKSPACE_ID,
        "subject": {"name": "dustin", "type": "IdentityFact"},
        "predicate": "prefers",
        "object": {"name": "tabs", "type": "PreferenceFact"},
        "source_metadata": {"plexo_memory_id": MEMORY_ID, "plexo_memory_type": "pattern"},
    }


def test_single_triplet_write_returns_expected_shape(client, fake_graphiti):
    import json
    raw = json.dumps(_valid_body()).encode("utf-8")
    res = client.post("/v1/triplets", content=raw, headers=_sign(raw))
    assert res.status_code == 200, res.text
    payload = res.json()
    assert "triplet_id" in payload
    assert isinstance(payload["triplet_id"], str) and len(payload["triplet_id"]) > 0
    latencies = payload["latencies"]
    assert isinstance(latencies["lock_wait_ms"], int) and latencies["lock_wait_ms"] >= 0
    assert isinstance(latencies["triplet_write_ms"], int) and latencies["triplet_write_ms"] >= 0

    # Verify route built EntityNode + EntityEdge per schema-mapping.md §3.
    src = fake_graphiti["source_node"]
    tgt = fake_graphiti["target_node"]
    edge = fake_graphiti["edge"]
    assert src.name == "dustin"
    assert src.labels == ["IdentityFact"]
    assert src.group_id == WORKSPACE_ID
    assert src.attributes["plexo_memory_type"] == "pattern"
    assert tgt.name == "tabs"
    assert tgt.labels == ["PreferenceFact"]
    assert tgt.group_id == WORKSPACE_ID
    assert edge.name == "prefers"
    assert edge.group_id == WORKSPACE_ID
    assert edge.source_node_uuid == src.uuid
    assert edge.target_node_uuid == tgt.uuid
    assert edge.attributes["plexo_memory_id"] == MEMORY_ID
    assert edge.attributes["plexo_memory_type"] == "pattern"


def test_dedup_double_write_both_succeed(client, fake_graphiti):
    """Graphiti dedups internally; the endpoint surface stays 200 on both calls."""
    import json
    raw = json.dumps(_valid_body()).encode("utf-8")
    r1 = client.post("/v1/triplets", content=raw, headers=_sign(raw))
    r2 = client.post("/v1/triplets", content=raw, headers=_sign(raw))
    assert r1.status_code == 200, r1.text
    assert r2.status_code == 200, r2.text
    assert "triplet_id" in r1.json()
    assert "triplet_id" in r2.json()


def test_invalid_workspace_id_returns_422(client, fake_graphiti):
    import json
    body = _valid_body()
    body["workspace_id"] = "not-a-uuid"
    raw = json.dumps(body).encode("utf-8")
    res = client.post("/v1/triplets", content=raw, headers=_sign(raw))
    assert res.status_code == 422, res.text


def test_invalid_entity_type_returns_422(client, fake_graphiti):
    import json
    body = _valid_body()
    body["subject"]["type"] = "BogusType"
    raw = json.dumps(body).encode("utf-8")
    res = client.post("/v1/triplets", content=raw, headers=_sign(raw))
    assert res.status_code == 422, res.text


def test_missing_source_metadata_memory_id_returns_422(client, fake_graphiti):
    import json
    body = _valid_body()
    body["source_metadata"] = {"plexo_memory_type": "pattern"}
    raw = json.dumps(body).encode("utf-8")
    res = client.post("/v1/triplets", content=raw, headers=_sign(raw))
    assert res.status_code == 422, res.text


def test_invalid_memory_type_returns_422(client, fake_graphiti):
    import json
    body = _valid_body()
    body["source_metadata"]["plexo_memory_type"] = "task"
    raw = json.dumps(body).encode("utf-8")
    res = client.post("/v1/triplets", content=raw, headers=_sign(raw))
    assert res.status_code == 422, res.text


def test_empty_predicate_returns_422(client, fake_graphiti):
    import json
    body = _valid_body()
    body["predicate"] = "   "
    raw = json.dumps(body).encode("utf-8")
    res = client.post("/v1/triplets", content=raw, headers=_sign(raw))
    assert res.status_code == 422, res.text


def test_valid_at_passthrough(client, fake_graphiti):
    """When valid_at supplied, edge.created_at + edge.valid_at reflect it."""
    import json
    body = _valid_body()
    body["valid_at"] = "2026-04-12T17:30:00Z"
    raw = json.dumps(body).encode("utf-8")
    res = client.post("/v1/triplets", content=raw, headers=_sign(raw))
    assert res.status_code == 200, res.text
    edge = fake_graphiti["edge"]
    assert edge.valid_at == datetime(2026, 4, 12, 17, 30, tzinfo=timezone.utc)
    assert edge.created_at == datetime(2026, 4, 12, 17, 30, tzinfo=timezone.utc)
