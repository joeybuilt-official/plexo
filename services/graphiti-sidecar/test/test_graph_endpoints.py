# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Joeybuilt LLC

"""
Tests for /v1/graph/write + /v1/graph/cypher (ADRs 0018/0020/0021).

Coverage:
- /v1/graph/write builds correct MERGE cypher for nodes + edges
- /v1/graph/write rejects unregistered labels (Phase F schema check)
- /v1/graph/write rejects unregistered edge types
- /v1/graph/cypher returns rows + header from underlying FalkorDB result
- Both endpoints reject invalid workspace_id (422) and missing HMAC (401)

FalkorDB client is mocked end-to-end — no live falkordb-py needed.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ["PLEXO_SERVICE_KEY"] = "test-service-key"
# Phase F: strict so schema violations raise 422 (default would only warn).
os.environ["GRAPHITI_SCHEMA_STRICT"] = "true"

import main  # noqa: E402

WORKSPACE_ID = "11111111-2222-3333-4444-555555555555"


def _sign(body: bytes) -> dict[str, str]:
    ts = datetime.now(timezone.utc).isoformat()
    sig = "sha256=" + hmac.new(
        main.SERVICE_KEY.encode("utf-8"), body, hashlib.sha256
    ).hexdigest()
    return {
        "X-Plexo-Signature": sig,
        "X-Plexo-Timestamp": ts,
        "Content-Type": "application/json",
    }


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture
def fake_falkor():
    """Mock _falkordb_client → graph → query so the route never touches FalkorDB.

    The MagicMock captures every query() call so tests can assert the cypher
    + params the route generated.
    """
    captured: list[tuple[str, dict]] = []

    async def fake_query(cypher: str, params: dict | None = None):
        captured.append((cypher, params or {}))
        # Default: return a fake QueryResult with empty result_set; tests that
        # need rows override this via fake_query_result.
        return SimpleNamespace(result_set=[], header=[])

    fake_graph = SimpleNamespace(query=fake_query)
    fake_client = SimpleNamespace(select_graph=lambda ws_id: fake_graph)

    with patch.object(main, "_falkordb_client", lambda: fake_client):
        yield {"captured": captured, "graph": fake_graph, "client": fake_client}


def _post(client: TestClient, path: str, body: dict):
    raw = json.dumps(body).encode("utf-8")
    return client.post(path, content=raw, headers=_sign(raw))


# ---------- /v1/graph/write ----------


def test_graph_write_creates_task_nodes_and_depends_on_edges(client, fake_falkor):
    body = {
        "workspace_id": WORKSPACE_ID,
        "app": "plexo",
        "nodes": [
            {
                "label": "Task",
                "id": "t1",
                "properties": {"description": "first", "status": "queued"},
            },
            {
                "label": "Task",
                "id": "t2",
                "properties": {"description": "second", "status": "queued"},
            },
        ],
        "edges": [
            {
                "type": "DEPENDS_ON",
                "from_label": "Task",
                "from_id": "t2",
                "to_label": "Task",
                "to_id": "t1",
                "properties": {},
            }
        ],
    }
    res = _post(client, "/v1/graph/write", body)
    assert res.status_code == 200, res.text
    payload = res.json()
    assert payload["nodes_written"] == 2
    assert payload["edges_written"] == 1

    # Verify 3 cypher calls (2 MERGE node, 1 MATCH+MERGE edge).
    assert len(fake_falkor["captured"]) == 3
    node_calls = fake_falkor["captured"][:2]
    edge_call = fake_falkor["captured"][2]
    for cypher, params in node_calls:
        assert cypher.startswith("MERGE (n:Task")
        assert "id" in params
        assert "props" in params
    assert "MATCH (a:Task" in edge_call[0]
    assert "MERGE (a)-[r:DEPENDS_ON]->(b)" in edge_call[0]
    assert edge_call[1]["from_id"] == "t2"
    assert edge_call[1]["to_id"] == "t1"


def test_graph_write_unregistered_label_returns_422(client, fake_falkor):
    body = {
        "workspace_id": WORKSPACE_ID,
        "nodes": [{"label": "Unicorn", "id": "u1", "properties": {}}],
        "edges": [],
    }
    res = _post(client, "/v1/graph/write", body)
    assert res.status_code == 422, res.text
    assert "Unicorn" in res.text
    # No cypher should have been issued.
    assert fake_falkor["captured"] == []


def test_graph_write_unregistered_edge_type_returns_422(client, fake_falkor):
    body = {
        "workspace_id": WORKSPACE_ID,
        "nodes": [],
        "edges": [
            {
                "type": "POINTS_AT",
                "from_label": "Task",
                "from_id": "t1",
                "to_label": "Task",
                "to_id": "t2",
                "properties": {},
            }
        ],
    }
    res = _post(client, "/v1/graph/write", body)
    assert res.status_code == 422, res.text
    assert "POINTS_AT" in res.text


def test_graph_write_invalid_workspace_id_returns_400(client, fake_falkor):
    body = {
        "workspace_id": "not-a-uuid",
        "nodes": [],
        "edges": [],
    }
    res = _post(client, "/v1/graph/write", body)
    assert res.status_code == 400, res.text


def test_graph_write_missing_hmac_returns_401(client, fake_falkor):
    res = client.post(
        "/v1/graph/write",
        json={"workspace_id": WORKSPACE_ID, "nodes": [], "edges": []},
    )
    assert res.status_code == 401, res.text


# ---------- /v1/graph/cypher ----------


@pytest.fixture
def fake_falkor_with_rows():
    """Same as fake_falkor but returns a QueryResult with 2 fake rows."""

    fake_node = SimpleNamespace(
        properties={"id": "t1", "description": "first"},
        labels=["Task"],
        id=1,
    )
    rows = [[fake_node, "value1"], [fake_node, "value2"]]
    header = [(1, "n"), (1, "name")]

    async def fake_query(cypher: str, params: dict | None = None):
        return SimpleNamespace(result_set=rows, header=header)

    fake_graph = SimpleNamespace(query=fake_query)
    fake_client = SimpleNamespace(select_graph=lambda ws_id: fake_graph)

    with patch.object(main, "_falkordb_client", lambda: fake_client):
        yield


def test_graph_cypher_returns_rows_and_header(client, fake_falkor_with_rows):
    body = {
        "workspace_id": WORKSPACE_ID,
        "cypher": "MATCH (n:Task) RETURN n, n.description AS name LIMIT 10",
        "params": {},
    }
    res = _post(client, "/v1/graph/cypher", body)
    assert res.status_code == 200, res.text
    payload = res.json()
    assert payload["header"] == ["n", "name"]
    assert len(payload["rows"]) == 2
    # First column was a Node — should be serialized as dict with labels+props.
    first_node = payload["rows"][0][0]
    assert first_node["labels"] == ["Task"]
    assert first_node["properties"]["id"] == "t1"
    assert payload["rows"][0][1] == "value1"


def test_graph_cypher_invalid_workspace_id_returns_400(client, fake_falkor):
    body = {
        "workspace_id": "not-a-uuid",
        "cypher": "MATCH (n) RETURN n",
        "params": {},
    }
    res = _post(client, "/v1/graph/cypher", body)
    assert res.status_code == 400


def test_graph_cypher_missing_hmac_returns_401(client, fake_falkor):
    res = client.post(
        "/v1/graph/cypher",
        json={"workspace_id": WORKSPACE_ID, "cypher": "MATCH (n) RETURN n", "params": {}},
    )
    assert res.status_code == 401
