# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Joeybuilt LLC

"""
Tests for main._is_read_only_cypher (the read-lock guard on /v1/graph/cypher).

_is_read_only_cypher is the INVERSE of plexo-api's isWriteCypher: it returns
True when the cypher is read-only (skips the per-workspace write lock so reads
aren't starved by in-flight ingestion). Same comment-strip + write-regex
semantics. A false positive (write classified as read) would let a write skip
the lock — correctness, not just latency.

main.py imports graphiti_core, which may not be installed in a local dev shell.
We import via sys.path like the neighbor tests; if the heavy dep is missing the
whole module is skipped (not errored) so this still runs green in the sidecar's
own container env where graphiti_core IS present.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("PLEXO_SERVICE_KEY", "test-service-key")

main = pytest.importorskip(
    "main",
    reason="graphiti_core (and other sidecar deps) not installed in this env; "
    "run inside the graphiti-sidecar container where they are present.",
)

# Read-only cases -> _is_read_only_cypher(...) is True
READ_CASES = [
    ("plain match/return", "MATCH (n:Entity)-[r:RELATES_TO]->(m:Entity) RETURN n, m LIMIT 500"),
    ("count aggregate", "MATCH (n) RETURN count(n) AS c"),
    ("db.labels procedure", "CALL db.labels()"),
    ("db.relationshipTypes procedure", "CALL db.relationshipTypes()"),
    ("write hidden in block comment", "MATCH (n) /* CREATE (x) */ RETURN n"),
    ("write hidden in line comment", "MATCH (n) RETURN n // DELETE n"),
]

# Write cases -> _is_read_only_cypher(...) is False
WRITE_CASES = [
    ("CREATE", "CREATE (x:Foo) RETURN x"),
    ("DETACH DELETE", "MATCH (n) DETACH DELETE n"),
    ("MERGE", "MERGE (a:X {id:1})"),
    ("SET", "MATCH (n) SET n.x = 1"),
    ("REMOVE", "MATCH (n) REMOVE n.x"),
    ("DROP", "DROP INDEX foo"),
    ("FOREACH", "FOREACH (x IN [1] | CREATE (:N))"),
    ("apoc.create", "CALL apoc.create.node(['L'], {})"),
    ("line-comment newline ends, CREATE real", "MATCH (n) // ok\nCREATE (x)"),
]


@pytest.mark.parametrize("name,cypher", READ_CASES, ids=[c[0] for c in READ_CASES])
def test_read_only_true(name, cypher):
    assert main._is_read_only_cypher(cypher) is True


@pytest.mark.parametrize("name,cypher", WRITE_CASES, ids=[c[0] for c in WRITE_CASES])
def test_read_only_false_for_writes(name, cypher):
    assert main._is_read_only_cypher(cypher) is False
