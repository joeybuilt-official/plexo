#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Joeybuilt LLC

"""Phase 11 schema-compat probe driver.

Drives a sidecar container that `probe.sh` has already started against a
throwaway FalkorDB, and asserts the three things a graphiti-core bump can
break, in the order they fail:

  1. `POST /v1/episodes` returns an `episode_id`  — the extraction +
     write pipeline still runs end to end.
  2. A read-only Cypher count sees nodes in the workspace graph — the
     write actually landed in FalkorDB, independent of any search path.
  3. `POST /v1/search` returns HTTP 200 with at least `PROBE_MIN_RESULTS`
     edges — the hybrid FTS + vector recall path still works for a
     hyphenated-UUID `group_id`. That is the regression
     `redisearch_groupid_patch.py` exists for: before it, RediSearch read
     the UUID's `-` as a negation operator and every search 500'd.

LLM quality is deliberately NOT under test: the inference backend is
`probe-stub.py`, which returns schema-shaped constants. A bump that
degrades extraction quality is caught by prod observation; this probe
catches a bump that breaks the *structure*.

Stdlib only — it runs on a bare CI runner with no venv.

Runs INSIDE a container on the probe's own docker network — `probe.sh` starts
it there rather than on the host, so the only host dependency is docker itself.

Usage (normally invoked by probe.sh):
  PROBE_SIDECAR_URL=http://<sidecar-container>:8080 PLEXO_SERVICE_KEY=... \
    python3 probe_client.py
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

SIDECAR_URL = os.environ.get("PROBE_SIDECAR_URL", "http://localhost:8080").rstrip("/")
SERVICE_KEY = os.environ.get("PLEXO_SERVICE_KEY", "")
# Hyphenated UUID on purpose: the hyphens are what broke RediSearch.
WORKSPACE = os.environ.get("PROBE_WORKSPACE", "00000000-0000-0000-0000-00000000c0fe")
# The probe stub answers every extraction call with schema-shaped constants, so
# the graph's fact text is "probe-stub-string", not the episode's prose. Query a
# token that is actually in the graph; see test/probe-text.md for why the
# episode text still carries real triples (a future content-aware stub, or a
# live-model probe, can assert on "Austin" without changing this driver).
QUERY = os.environ.get("PROBE_QUERY", "probe")
MIN_RESULTS = int(os.environ.get("PROBE_MIN_RESULTS", "1"))
TIMEOUT_S = int(os.environ.get("PROBE_HTTP_TIMEOUT_S", "300"))

EPISODE_TEXT = """Phase 3c probe marker.
Alice manages Bob.
Bob reports to Alice.
Alice works at Acme.
Acme is headquartered in Austin.
Bob lives in Austin."""


def _post(path: str, payload: dict) -> tuple[int, dict]:
    """POST with the sidecar's inbound HMAC headers (main.py `_verify_hmac`)."""
    raw = json.dumps(payload).encode()
    ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    sig = "sha256=" + hmac.new(SERVICE_KEY.encode(), raw, hashlib.sha256).hexdigest()
    req = urllib.request.Request(
        f"{SIDECAR_URL}{path}",
        data=raw,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Plexo-Signature": sig,
            "X-Plexo-Timestamp": ts,
            "X-Plexo-App": "plexo",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as err:
        body = err.read().decode(errors="replace")
        try:
            return err.code, json.loads(body or "{}")
        except json.JSONDecodeError:
            return err.code, {"raw": body}


def _fail(step: str, detail: object) -> None:
    print(f"PROBE FAIL [{step}]: {detail}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    if not SERVICE_KEY:
        _fail("config", "PLEXO_SERVICE_KEY is required")

    with urllib.request.urlopen(f"{SIDECAR_URL}/v1/health", timeout=30) as res:
        health = json.loads(res.read())
    print(f"probe: sidecar healthy, graphiti-core=={health.get('graphiti_version')}")

    status, body = _post(
        "/v1/episodes",
        {
            "workspace_id": WORKSPACE,
            "name": "phase-11-probe",
            "content": EPISODE_TEXT,
            "source_description": "phase-11-probe",
            "episode_type": "text",
        },
    )
    if status != 200:
        _fail("episodes", f"HTTP {status} {body}")
    if not body.get("episode_id"):
        _fail("episodes", f"no episode_id in {body}")
    print(f"probe: ingest ok, episode_id={body['episode_id']}")

    status, body = _post(
        "/v1/graph/cypher",
        {"workspace_id": WORKSPACE, "cypher": "MATCH (n) RETURN count(n)"},
    )
    if status != 200:
        _fail("cypher", f"HTTP {status} {body}")
    rows = body.get("rows") or []
    node_count = rows[0][0] if rows and rows[0] else 0
    if not isinstance(node_count, int) or node_count < 1:
        _fail("cypher", f"expected nodes in the graph, got count={node_count!r}")
    print(f"probe: graph write landed, node_count={node_count}")

    status, body = _post(
        "/v1/search",
        {"workspace_id": WORKSPACE, "query": QUERY, "num_results": 10},
    )
    if status != 200:
        # The RediSearch group_id regression lands exactly here, as a 500.
        _fail("search", f"HTTP {status} {body}")
    results = body.get("results") or []
    if len(results) < MIN_RESULTS:
        _fail("search", f"expected >={MIN_RESULTS} results for {QUERY!r}, got {len(results)}")
    print(f"probe: search ok, {len(results)} result(s) for {QUERY!r}")
    print("PROBE PASS")


if __name__ == "__main__":
    main()
