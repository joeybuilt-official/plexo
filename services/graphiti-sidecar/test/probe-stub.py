# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Joeybuilt LLC

"""Phase 11 schema-compat probe stub.

Stand-in for plexo-api's inference shim during the upstream-watcher
schema-compat probe (see graphiti-migration/phase-11-design.md §"Probe
stub").

Returns deterministic, schema-compliant responses on:
  POST /api/inference/ws/{ws}/v1/embeddings        → 256-dim zero vector
  POST /api/inference/ws/{ws}/v1/chat/completions  → canonical extraction shape

The point is to test graphiti's pipeline + Kuzu file format against a
new graphiti-core version. LLM quality is NOT the variable under test
here — that's caught downstream by prod observation, not the bump probe.

HMAC verification mirrors apps/api's requireServiceKey middleware so the
sidecar's signed-and-timestamped requests succeed end-to-end. Same
PLEXO_SERVICE_KEY env var the prod stack uses.

Run:
  PLEXO_SERVICE_KEY=<key> uvicorn probe-stub:app --host 127.0.0.1 --port 8090
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from datetime import UTC, datetime
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

SERVICE_KEY = os.environ.get("PLEXO_SERVICE_KEY", "")
TIMESTAMP_TOLERANCE_S = 300  # ±5 min, matches sidecar gmessages-receiver

app = FastAPI(title="phase-11 probe stub", version="0.1.0")


async def _verify_hmac(request: Request) -> bytes:
    raw = await request.body()
    if not SERVICE_KEY:
        # Stub mode — operator forgot to set the key. Fail loudly so the
        # probe surfaces config errors instead of silently passing.
        raise HTTPException(401, detail="PLEXO_SERVICE_KEY not configured")

    sig_header = request.headers.get("X-Plexo-Signature", "")
    ts_header = request.headers.get("X-Plexo-Timestamp", "")
    if not sig_header.startswith("sha256="):
        raise HTTPException(401, detail="missing or malformed X-Plexo-Signature")
    if not ts_header:
        raise HTTPException(401, detail="missing X-Plexo-Timestamp")

    try:
        ts = datetime.fromisoformat(ts_header.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(401, detail="X-Plexo-Timestamp not ISO-8601") from None
    skew = abs((datetime.now(UTC) - ts).total_seconds())
    if skew > TIMESTAMP_TOLERANCE_S:
        raise HTTPException(401, detail=f"timestamp skew {skew:.0f}s exceeds {TIMESTAMP_TOLERANCE_S}s")

    expected = "sha256=" + hmac.new(
        SERVICE_KEY.encode(),
        raw + ts_header.encode(),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(sig_header, expected):
        raise HTTPException(401, detail="HMAC mismatch")

    return raw


@app.get("/v1/health")
async def health() -> JSONResponse:
    """Public health probe; matches sidecar's own /v1/health shape."""
    return JSONResponse({
        "ok": True,
        "service": "probe-stub",
        "hmac_configured": bool(SERVICE_KEY),
    })


@app.post("/api/inference/ws/{workspace_id}/v1/embeddings")
async def embeddings(workspace_id: str, request: Request) -> JSONResponse:
    raw = await _verify_hmac(request)
    body = json.loads(raw or b"{}")
    inputs = body.get("input", [])
    if isinstance(inputs, str):
        inputs = [inputs]
    # Deterministic 256-dim vector — alternating 0.1 / -0.1 so cosine
    # similarity is non-degenerate but identical across runs.
    vec = [0.1 if i % 2 == 0 else -0.1 for i in range(256)]
    data = [{"object": "embedding", "index": i, "embedding": vec} for i in range(len(inputs))]
    return JSONResponse({
        "object": "list",
        "data": data,
        "model": body.get("model", "probe-stub-embed"),
        "usage": {"prompt_tokens": 0, "total_tokens": 0},
    })


@app.post("/api/inference/ws/{workspace_id}/v1/chat/completions")
async def chat_completions(workspace_id: str, request: Request) -> JSONResponse:
    raw = await _verify_hmac(request)
    body = json.loads(raw or b"{}")

    fmt = body.get("response_format") or {}
    if fmt.get("type") == "json_schema":
        schema = (fmt.get("json_schema") or {}).get("schema") or {}
        canned = _canonical_response_for_schema(schema)
        content = json.dumps(canned)
    else:
        # Text-mode fallback. graphiti's primary path is json_schema, but a
        # few summarise calls are text. Keep the response short + stable.
        content = "Probe-stub deterministic summary."

    return JSONResponse({
        "id": "chatcmpl-probe-stub",
        "object": "chat.completion",
        "created": int(datetime.now(UTC).timestamp()),
        "model": body.get("model", "probe-stub-chat"),
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content},
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    })


def _canonical_response_for_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Synthesize a minimal schema-compliant object.

    Walks the top-level required properties + emits a deterministic value
    matching each declared type. Arrays get one stub element; nested
    objects recurse. Covers the graphiti-core 0.29 pipeline schemas
    (extracted_entities, extracted_edges, summary, dedup, attributes)
    without per-version chasing — every new shape passes as long as the
    JSON Schema is well-formed.
    """
    if schema.get("type") != "object":
        return {}
    out: dict[str, Any] = {}
    properties = schema.get("properties") or {}
    required = schema.get("required") or list(properties.keys())
    defs = {**(schema.get("$defs") or {}), **(schema.get("definitions") or {})}
    for key in required:
        prop = properties.get(key, {})
        out[key] = _value_for(prop, defs)
    return out


def _value_for(prop: dict[str, Any], defs: dict[str, Any]) -> Any:
    if "$ref" in prop:
        ref = prop["$ref"].rsplit("/", 1)[-1]
        prop = defs.get(ref, {})
    t = prop.get("type")
    if isinstance(t, list):
        # nullable union — pick the non-null type
        t = next((x for x in t if x != "null"), "string")
    if t == "string":
        return prop.get("default", "probe-stub-string")
    if t == "integer":
        return prop.get("default", 0)
    if t == "number":
        return prop.get("default", 0.0)
    if t == "boolean":
        return prop.get("default", False)
    if t == "array":
        items = prop.get("items") or {}
        return [_value_for(items, defs)]
    if t == "object":
        return _canonical_response_for_schema({**prop, "type": "object"})
    if "enum" in prop and prop["enum"]:
        return prop["enum"][0]
    return None
